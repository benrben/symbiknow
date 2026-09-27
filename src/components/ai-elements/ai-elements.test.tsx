// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "./conversation";
import { Message, MessageContent, MessageResponse } from "./message";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
} from "./prompt-input";
import { Suggestion, Suggestions } from "./suggestion";

const library = vi.hoisted(() => ({ isAtBottom: false, scrollCalls: 0, streamRenders: 0 }));

vi.mock("@base-ui/react/button", async () => {
  const React = await import("react");
  return { Button: (props: Record<string, unknown>) => React.createElement("button", props) };
});

vi.mock("use-stick-to-bottom", async () => {
  const React = await import("react");
  const StickToBottom = Object.assign(
    (props: { className?: string; role?: string; children?: React.ReactNode }) =>
      React.createElement("section", { className: props.className, role: props.role }, props.children),
    {
      Content: (props: { className?: string; children?: React.ReactNode }) =>
        React.createElement("div", { className: props.className }, props.children),
    }
  );
  return {
    StickToBottom,
    useStickToBottomContext: () => ({
      isAtBottom: library.isAtBottom,
      scrollToBottom: () => { library.scrollCalls++; },
    }),
  };
});

vi.mock("streamdown", async () => {
  const React = await import("react");
  return {
    Streamdown: (props: { className?: string; children?: React.ReactNode }) => {
      library.streamRenders++;
      return React.createElement("div", { className: props.className }, props.children);
    },
  };
});

afterEach(() => {
  cleanup();
  library.isAtBottom = false;
  library.scrollCalls = 0;
  library.streamRenders = 0;
});

describe("AI Elements conversation and messages", () => {
  it("renders a conversation and scrolls to the latest message when needed", () => {
    const { rerender } = render(
      <Conversation className="chat-log">
        <ConversationContent className="chat-items">Hello</ConversationContent>
        <ConversationScrollButton aria-label="Scroll to latest" />
      </Conversation>
    );
    expect(screen.getByRole("log").className).toContain("chat-log");
    expect(screen.getByText("Hello").className).toContain("chat-items");
    fireEvent.click(screen.getByRole("button", { name: "Scroll to latest" }));
    expect(library.scrollCalls).toBe(1);
    library.isAtBottom = true;
    rerender(
      <Conversation>
        <ConversationContent>Hello</ConversationContent>
        <ConversationScrollButton aria-label="Scroll to latest" />
      </Conversation>
    );
    expect(screen.queryByRole("button", { name: "Scroll to latest" })).toBeNull();
  });

  it("distinguishes user and assistant messages and memoizes unchanged response content", () => {
    const { rerender } = render(
      <>
        <Message from="user"><MessageContent>Question</MessageContent></Message>
        <Message from="assistant"><MessageContent><MessageResponse isAnimating={false}>Answer</MessageResponse></MessageContent></Message>
      </>
    );
    expect(screen.getByText("Question").closest(".is-user")).toBeTruthy();
    expect(screen.getByText("Answer").closest(".is-assistant")).toBeTruthy();
    expect(library.streamRenders).toBe(1);
    rerender(
      <>
        <Message from="user"><MessageContent>Question</MessageContent></Message>
        <Message from="assistant"><MessageContent><MessageResponse isAnimating={false}>Answer</MessageResponse></MessageContent></Message>
      </>
    );
    expect(library.streamRenders).toBe(1);
    rerender(<Message from="assistant"><MessageContent><MessageResponse isAnimating>Answer</MessageResponse></MessageContent></Message>);
    expect(library.streamRenders).toBe(2);
    rerender(<Message from="assistant"><MessageContent><MessageResponse isAnimating>Revised</MessageResponse></MessageContent></Message>);
    expect(library.streamRenders).toBe(3);
  });

  it("suggestions use a native horizontal scroller and pass their text to the click handler", () => {
    const onClick = vi.fn();
    render(
      <Suggestions className="quick-prompts">
        <Suggestion suggestion="Summarize" onClick={onClick} />
        <Suggestion suggestion="Explore" onClick={onClick}>Custom label</Suggestion>
        <Suggestion suggestion="No callback" />
      </Suggestions>
    );
    const scroller = screen.getByText("Summarize").closest(".overflow-x-auto");
    expect(scroller?.className).toContain("whitespace-nowrap");
    expect(scroller?.querySelector(".quick-prompts")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Summarize" }));
    fireEvent.click(screen.getByRole("button", { name: "Custom label" }));
    fireEvent.click(screen.getByRole("button", { name: "No callback" }));
    expect(onClick.mock.calls.map(call => call[0])).toEqual(["Summarize", "Explore"]);
  });
});

function composer(onSubmit: (message: { text: string; files: unknown[] }) => void | Promise<void>, status: "ready" | "submitted" | "streaming" | "error" = "ready", onStop?: () => void) {
  return (
    <PromptInput onSubmit={onSubmit}>
      <PromptInputBody><PromptInputTextarea aria-label="Ask" /></PromptInputBody>
      <PromptInputFooter><span>Model</span><PromptInputSubmit status={status} onStop={onStop} /></PromptInputFooter>
    </PromptInput>
  );
}

describe("AI Elements prompt input", () => {
  it("submits trimmed text with an empty file list, clears on success, and focuses from the footer", async () => {
    const onSubmit = vi.fn(async (message: { text: string; files: unknown[] }) => { void message; });
    render(composer(onSubmit));
    const textarea = screen.getByRole("textbox", { name: "Ask" }) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "  Hello canvas  " } });
    fireEvent.click(screen.getByText("Model"));
    expect(document.activeElement).toBe(textarea);
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0]).toEqual({ text: "Hello canvas", files: [] });
    await waitFor(() => expect(textarea.value).toBe(""));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("ignores a submit if the composition has no message field", () => {
    const onSubmit = vi.fn();
    render(<PromptInput onSubmit={onSubmit}><PromptInputSubmit /></PromptInput>);
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("uses Enter to submit and preserves Shift+Enter, composition, disabled submit, and prevented key events", async () => {
    const onSubmit = vi.fn(async () => undefined);
    const prevent = vi.fn((event: React.KeyboardEvent<HTMLTextAreaElement>) => event.preventDefault());
    const { rerender } = render(composer(onSubmit));
    const textarea = screen.getByRole("textbox", { name: "Ask" });
    fireEvent.change(textarea, { target: { value: "Hello canvas" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    fireEvent.compositionStart(textarea);
    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.compositionEnd(textarea);
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));

    rerender(
      <PromptInput onSubmit={onSubmit}>
        <PromptInputTextarea aria-label="Ask" defaultValue="Again" onKeyDown={prevent} />
        <PromptInputSubmit />
      </PromptInput>
    );
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Ask" }), { key: "Enter" });
    expect(prevent).toHaveBeenCalled();
    expect(onSubmit).toHaveBeenCalledTimes(1);

    rerender(
      <PromptInput onSubmit={onSubmit}>
        <PromptInputTextarea aria-label="Ask" defaultValue="Again" />
        <PromptInputSubmit disabled />
      </PromptInput>
    );
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Ask" }), { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("preserves text and reports a rejected submission", async () => {
    const onSubmit = vi.fn().mockRejectedValueOnce(new Error("Provider unavailable")).mockRejectedValueOnce("offline");
    render(composer(onSubmit));
    const textarea = screen.getByRole("textbox", { name: "Ask" }) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "Hello canvas" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Provider unavailable");
    expect(textarea.value).toContain("Hello canvas");
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Could not send message."));
    expect(textarea.value).toContain("Hello canvas");
  });

  it("shows generation states and lets Stop bypass form submission", async () => {
    const onSubmit = vi.fn();
    const onStop = vi.fn();
    const { rerender } = render(composer(onSubmit, "submitted", onStop));
    expect(screen.getByRole("status", { name: "Loading" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();

    rerender(composer(onSubmit, "streaming", onStop));
    expect(screen.getByRole("button", { name: "Stop" }).getAttribute("type")).toBe("button");
    rerender(composer(onSubmit, "streaming"));
    expect(screen.getByRole("button", { name: "Stop" }).getAttribute("type")).toBe("submit");
    rerender(composer(onSubmit, "error"));
    expect(screen.getByRole("button", { name: "Submit" })).toBeTruthy();
    rerender(composer(onSubmit, "ready"));
    expect(screen.getByRole("button", { name: "Submit" }).getAttribute("type")).toBe("submit");
  });
});
