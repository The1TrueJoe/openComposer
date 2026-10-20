// No console window on Windows. Piped stdio (for --mcp-stdio) still works.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--mcp-stdio") {
        opencomposer::bridge::main(args.iter().any(|a| a == "--agent"));
        return;
    }
    opencomposer::run();
}
