import DOMPurify from "dompurify";
import { marked } from "marked";
import { useMemo } from "react";

/** Markdown from the agent, rendered. Sanitised: the text comes from a model that read the
 *  project, and a device name or a driver's own strings could carry HTML. */
export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true, breaks: true }) as string), [text]);
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}
