import { useState, useRef, useEffect, useCallback } from "react";
import type { OutputLine } from "../../lib/sdk/types";

export type StreamCallback = (line: OutputLine) => void;

interface WebTerminalProps {
  onCommand: (input: string, stream?: StreamCallback) => Promise<OutputLine[]>;
  prompt?: string;
  initialOutput?: OutputLine[];
}

export function WebTerminal({
  onCommand,
  prompt = ">",
  initialOutput = [],
}: WebTerminalProps) {
  const [history, setHistory] = useState<OutputLine[]>(initialOutput);
  const [input, setInput] = useState("");
  const [commandHistory, setCommandHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [isProcessing, setIsProcessing] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const outputRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [history]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!input.trim() || isProcessing) return;

      const cmd = input.trim();

      setHistory((prev) => [
        ...prev,
        { type: "plain", text: `${prompt} ${cmd}` },
      ]);
      setCommandHistory((prev) => [...prev, cmd]);
      setHistoryIndex(-1);
      setInput("");
      setIsProcessing(true);

      const streamLine: StreamCallback = (line) => {
        setHistory((prev) => {
          if (line.id) {
            const at = prev.findIndex((l) => l.id === line.id);
            if (at >= 0) {
              const next = prev.slice();
              next[at] = line;
              return next;
            }
          }
          return [...prev, line];
        });
      };

      try {
        const output = await onCommand(cmd, streamLine);
        if (output.length > 0) {
          setHistory((prev) => [...prev, ...output]);
        }
      } catch (err) {
        setHistory((prev) => [
          ...prev,
          {
            type: "error",
            text: `Error: ${err instanceof Error ? err.message : "Unknown error"}`,
          },
        ]);
      } finally {
        setIsProcessing(false);
        setTimeout(() => inputRef.current?.focus(), 100);
      }
    },
    [input, isProcessing, onCommand, prompt],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowUp") {
        e.preventDefault();
        if (commandHistory.length > 0) {
          const newIndex =
            historyIndex === -1
              ? commandHistory.length - 1
              : Math.max(0, historyIndex - 1);
          setHistoryIndex(newIndex);
          setInput(commandHistory[newIndex]);
        }
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        if (historyIndex !== -1) {
          const newIndex = historyIndex + 1;
          if (newIndex >= commandHistory.length) {
            setHistoryIndex(-1);
            setInput("");
          } else {
            setHistoryIndex(newIndex);
            setInput(commandHistory[newIndex]);
          }
        }
      }
    },
    [commandHistory, historyIndex],
  );

  const getLineClass = (type: OutputLine["type"]) => {
    switch (type) {
      case "success":
        return "text-ink";
      case "pending":
        // In-flight work breathes: replace-by-id rows in this state pulse
        // until a terminal state (success/warn) replaces them.
        return "text-muted terminal-pending";
      case "error":
        return "text-error";
      case "warn":
        return "text-accent";
      case "info":
        return "text-accent";
      case "dim":
        return "text-muted";
      case "bold":
        return "text-ink font-bold";
      case "plain":
      default:
        return "text-ink";
    }
  };

  const handleContainerClick = useCallback((e: React.MouseEvent) => {
    const selection = window.getSelection();
    if (selection && selection.toString().length > 0) {
      return;
    }
    if (
      e.target === e.currentTarget ||
      (e.target as HTMLElement).closest("[data-output]")
    ) {
      inputRef.current?.focus();
    }
  }, []);

  return (
    <div
      className="bg-inset border border-rule font-mono text-sm h-full flex flex-col overflow-hidden"
      onClick={handleContainerClick}
    >
      <div
        ref={outputRef}
        data-output
        className="flex-1 overflow-y-auto p-4 space-y-0.5 select-text cursor-text"
      >
        {history.map((line, i) => (
          <div
            key={i}
            className={`${getLineClass(line.type)} whitespace-pre-wrap break-all`}
          >
            {line.text}
          </div>
        ))}
        {isProcessing && <div className="text-muted">Processing...</div>}
      </div>

      <form
        onSubmit={handleSubmit}
        className="border-t border-rule p-3 flex items-center gap-2"
      >
        <span className="text-accent font-bold">{prompt}</span>
        <input
          ref={inputRef}
          data-testid="terminal-input"
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isProcessing}
          className="flex-1 bg-transparent text-ink outline-none placeholder-faint caret-accent"
          placeholder={isProcessing ? "Processing..." : "Type a command..."}
          autoComplete="off"
          spellCheck={false}
        />
      </form>
    </div>
  );
}
