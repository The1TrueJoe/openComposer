"""Read-only proof of concept: dump a Control4 project and its connections over c4soap.

Usage:
    C4_CERT=composer.pem C4_KEY=composer.key python3 poc/c4read.py <controller-ip> [out-dir]

Only Get* / Is* commands are allowed; anything else is refused before it hits the wire.
"""
import os
import socket
import ssl
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

READ_ONLY_PREFIXES = ("Get", "Is")
# Not Get*-named, but they only read: Upload returns the project for a backup.
READ_ONLY_METHODS = {"Upload"}
PORT = 5021


class Director:
    def __init__(self, host, cert, key, allow_write=False, timeout=30):
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE  # controllers present a self-signed cert
        ctx.load_cert_chain(cert, key)
        self.sock = ctx.wrap_socket(socket.create_connection((host, PORT), timeout=timeout))
        self.buf = b""
        self.allow_write = allow_write

    def call(self, method, _raw_params="", **params):
        if not (self.allow_write or method.startswith(READ_ONLY_PREFIXES) or method in READ_ONLY_METHODS):
            raise PermissionError(f"refusing non-read-only method {method}")
        body = _raw_params + "".join(
            f'<param name="{k}" type="{_type(v)}">{_value(v)}</param>' for k, v in params.items()
        )
        msg = (f'<c4soap name="{method}" session="0" operation="RWX" category="composer" '
               f'async="False">{body}</c4soap>')
        self.sock.sendall(msg.encode() + b"\0")
        while True:
            reply = self._read_message()
            root = ET.fromstring(reply)
            # Skip unsolicited event pushes; wait for the reply to our call.
            if root.tag == "c4soap" and root.get("name") == method:
                return reply, root

    def _read_message(self):
        while b"\0" not in self.buf:
            chunk = self.sock.recv(1 << 16)
            if not chunk:
                raise ConnectionError("director closed the connection")
            self.buf += chunk
        msg, self.buf = self.buf.split(b"\0", 1)
        return msg.decode("utf-8", errors="replace")


def _type(v):
    return "bool" if isinstance(v, bool) else "number" if isinstance(v, int) else "string"


def _value(v):
    return str(int(v)) if isinstance(v, bool) else str(v)


def main():
    host = sys.argv[1]
    out = Path(sys.argv[2] if len(sys.argv) > 2 else "poc/out")
    out.mkdir(parents=True, exist_ok=True)
    d = Director(host, os.environ["C4_CERT"], os.environ["C4_KEY"])

    def save(name, raw):
        (out / f"{name}.xml").write_text(raw)

    raw, root = d.call("GetVersionInfo")
    save("versions", raw)
    director_ver = next((v.get("version") for v in root.iter("version") if v.get("name") == "Director"), "?")

    raw, root = d.call("GetItems")
    save("items", raw)
    items = {}
    for it in root.iter("item"):
        iid = it.findtext("id")
        if iid is None:
            continue
        items[int(iid)] = {
            "name": it.findtext("name"),
            "type": int(it.findtext("type") or 0),
            "parent": int(it.findtext("parentid") or 0),
            "c4i": it.findtext("itemdata/config_data_file") or it.findtext("itemdata/c4i") or "",
        }
    print(f"Director {director_ver}: {len(items)} items")

    bindings = []
    bdir = out / "bindings"
    bdir.mkdir(exist_ok=True)
    for iid in sorted(items):
        raw, root = d.call("GetBindingsByDevice", iddevice=iid)
        if root.find(".//binding") is None:
            continue
        (bdir / f"{iid}.xml").write_text(raw)
        for b in root.iter("binding"):
            # Each connection is reported on both ends; keep only the consumer side.
            if b.findtext("provider") == "1":
                continue
            for bound in b.iter("bound"):
                cls = ",".join(c.text for c in bound.iter("boundclass"))
                bindings.append((iid, b.findtext("name"), cls,
                                 int(bound.findtext("deviceid") or 0), bound.findtext("name")))

    network = []
    for t in (1, 2, 3):
        raw, root = d.call("GetNetworkBindings", type=t)
        save(f"network_bindings_{t}", raw)
        for nb in root.iter("networkbinding"):
            network.append({k: nb.findtext(k) for k in ("deviceid", "addr", "ssdptype", "uuid", "status")})
    raw, _ = d.call("GetNetworkConnections")
    save("network_connections", raw)

    def name(i):
        return items.get(i, {}).get("name", i)

    print(f"\n{len(bindings)} connections (consumer <- provider):")
    for iid, bname, cls, other, oname in bindings:
        print(f"  {name(iid)!s:28} {bname!s:22} <- {name(other)!s:28} {oname!s:22} [{cls}]")
    print(f"\n{len(network)} network/SDDP bindings:")
    for n in network:
        print(f"  {name(int(n['deviceid'] or 0))!s:28} {n['status'] or '':8} {n['addr'] or '-':16} {n['ssdptype'] or ''}")
    print(f"\nraw XML saved under {out}/")


if __name__ == "__main__":
    main()
