"use client";

// Text-only AI Elements prompt input for the canvas chat. Attachment and
// provider controls from the generated component are unused by this app.
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import type { ChatStatus, FileUIPart } from "ai";
import { CornerDownLeftIcon, SquareIcon, XIcon } from "lucide-react";
import type { ComponentProps, FormEvent, KeyboardEvent, KeyboardEventHandler } from "react";
import { useCallback, useState } from "react";

export interface PromptInputMessage {
  text: string;
  files: FileUIPart[];
}

export type PromptInputProps = Omit<ComponentProps<"form">, "onSubmit"> & {
  onSubmit: (message: PromptInputMessage, event: FormEvent<HTMLFormElement>) => void | Promise<void>;
};

export const PromptInput = ({ className, children, onSubmit, ...props }: PromptInputProps) => {
  const [error, setError] = useState("");

  const handleSubmit = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const text = String(new FormData(form).get("message") ?? "").trim();
    if (!text) return;
    setError("");
    try {
      await onSubmit({ text, files: [] }, event);
      form.reset();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not send message.");
    }
  }, [onSubmit]);

  return (
    <>
      <form className={cn("w-full", className)} onSubmit={handleSubmit} {...props}>
        <InputGroup className="overflow-hidden">{children}</InputGroup>
      </form>
      {error && <p role="alert">{error}</p>}
    </>
  );
};

export type PromptInputBodyProps = ComponentProps<"div">;

export const PromptInputBody = ({ className, ...props }: PromptInputBodyProps) => (
  <div className={cn("contents", className)} {...props} />
);

export type PromptInputTextareaProps = ComponentProps<typeof InputGroupTextarea>;

function isPlainEnter(event: KeyboardEvent<HTMLTextAreaElement>, composing: boolean): boolean {
  return !event.defaultPrevented && event.key === "Enter" && !event.shiftKey && !composing && !event.nativeEvent.isComposing;
}

export const PromptInputTextarea = ({
  onKeyDown,
  className,
  placeholder = "What would you like to know?",
  ...props
}: PromptInputTextareaProps) => {
  const [isComposing, setIsComposing] = useState(false);

  const handleKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = useCallback((event) => {
    onKeyDown?.(event);
    if (!isPlainEnter(event, isComposing)) return;
    event.preventDefault();
    const form = event.currentTarget.form;
    const submit = form?.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (!submit?.disabled) form?.requestSubmit();
  }, [onKeyDown, isComposing]);

  return (
    <InputGroupTextarea
      className={cn("field-sizing-content max-h-48 min-h-16", className)}
      name="message"
      onCompositionEnd={() => setIsComposing(false)}
      onCompositionStart={() => setIsComposing(true)}
      onKeyDown={handleKeyDown}
      placeholder={placeholder}
      {...props}
    />
  );
};

export type PromptInputFooterProps = Omit<ComponentProps<typeof InputGroupAddon>, "align">;

export const PromptInputFooter = ({ className, ...props }: PromptInputFooterProps) => (
  <InputGroupAddon align="block-end" className={cn("justify-between gap-1", className)} {...props} />
);

export type PromptInputSubmitProps = ComponentProps<typeof InputGroupButton> & {
  status?: ChatStatus;
  onStop?: () => void;
};

function submitPresentation(status: ChatStatus | undefined, canStop: boolean) {
  const stopType = canStop ? "button" : "submit";
  if (status === "submitted") return { icon: <Spinner />, label: "Stop", type: stopType, generating: true } as const;
  if (status === "streaming") return { icon: <SquareIcon className="size-4" />, label: "Stop", type: stopType, generating: true } as const;
  if (status === "error") return { icon: <XIcon className="size-4" />, label: "Submit", type: "submit", generating: false } as const;
  return { icon: <CornerDownLeftIcon className="size-4" />, label: "Submit", type: "submit", generating: false } as const;
}

export const PromptInputSubmit = ({
  className,
  variant = "default",
  size = "icon-sm",
  status,
  onStop,
  onClick,
  children,
  ...props
}: PromptInputSubmitProps) => {
  const presentation = submitPresentation(status, Boolean(onStop));

  const handleClick = useCallback((event: Parameters<NonNullable<PromptInputSubmitProps["onClick"]>>[0]) => {
    if (presentation.generating && onStop) {
      event.preventDefault();
      onStop();
      return;
    }
    onClick?.(event);
  }, [presentation.generating, onStop, onClick]);

  return (
    <InputGroupButton
      aria-label={presentation.label}
      className={cn(className)}
      onClick={handleClick}
      size={size}
      type={presentation.type}
      variant={variant}
      {...props}
    >
      {children ?? presentation.icon}
    </InputGroupButton>
  );
};
