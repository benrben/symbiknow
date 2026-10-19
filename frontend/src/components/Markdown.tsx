import { lazy, Suspense, type ComponentProps } from "react";
import type ReactMarkdown from "react-markdown";
const Renderer = lazy(() => import("./MarkdownRenderer"));
export default function Markdown(
  props: ComponentProps<typeof ReactMarkdown> & { highlights?: string[] },
) {
  return (
    <Suspense
      fallback={
        <span className="secondary" role="status">
          Rendering text…
        </span>
      }
    >
      <Renderer {...props} />
    </Suspense>
  );
}
