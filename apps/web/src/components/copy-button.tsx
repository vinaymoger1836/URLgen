"use client";

import { useEffect, useState } from "react";

/**
 * Copies a short URL, and says so.
 *
 * The confirmation matters more than it looks: a copy button with no feedback gets
 * clicked three times, and the only way to check whether it worked is to paste
 * somewhere and look.
 */
export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!copied && !failed) {
      return;
    }
    const timer = setTimeout(() => {
      setCopied(false);
      setFailed(false);
    }, 1_500);
    return () => {
      clearTimeout(timer);
    };
  }, [copied, failed]);

  return (
    <button
      type="button"
      onClick={() => {
        /* The clipboard API needs a secure context and permission, and refuses in
           an iframe without one. Saying "copy failed" beats a button that silently
           does nothing. */
        navigator.clipboard.writeText(value).then(
          () => {
            setCopied(true);
          },
          () => {
            setFailed(true);
          },
        );
      }}
      className="shrink-0 rounded border border-hairline px-2 py-0.5 text-xs text-ink-2 hover:bg-plane"
    >
      {failed ? "Copy failed" : copied ? "Copied" : label}
    </button>
  );
}
