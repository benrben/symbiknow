import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Children, type ComponentProps, type ReactNode } from "react";
// One syntax and resource policy for the reader, Quick Look and bounded cards.
// Raw HTML is ignored; remote images and active links are never rendered.
export default function Markdown({
  components,
  highlights = [],
  ...props
}: ComponentProps<typeof ReactMarkdown> & { highlights?: string[] }) {
  const highlighted = (children: ReactNode) =>
    Children.map(children, (child) =>
      typeof child === "string" &&
      child.trim().length > 12 &&
      highlights.some((text) => text.includes(child.trim())) ? (
        <mark>{child}</mark>
      ) : (
        child
      ),
    );
  const safe: Components = {
    td: ({ children, style }) => <td style={style}>{highlighted(children)}</td>,
    th: ({ children, style }) => <th style={style}>{highlighted(children)}</th>,
    img: () => null,
    a: ({ children }) => <span>{children}</span>,
    table: ({ children }) => (
      <div
        className="markdown-table-scroll"
        role="region"
        aria-label="Document table"
        tabIndex={0}
      >
        <table>{children}</table>
      </div>
    ),
    ...components,
  };
  return (
    <ReactMarkdown
      {...props}
      skipHtml
      remarkPlugins={[remarkGfm]}
      components={safe}
    />
  );
}
