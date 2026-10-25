import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

export default function Answer({ text }: { text: string }) {
  return (
    <div className="assistant-answer">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ href, children }) =>
            href && /^(https?:\/\/|mailto:)/i.test(href) ? (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
          // Remote images can track readers; references stay text until deliberately opened.
          img: ({ alt }) => (
            <span className="assistant-muted">
              {alt ? `[Image: ${alt}]` : "[Image]"}
            </span>
          ),
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}
