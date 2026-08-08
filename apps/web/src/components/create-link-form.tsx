"use client";

/**
 * The write path's one piece of UI.
 *
 * The API already knows every rule about what may be shortened — private address
 * ranges, unsupported schemes, reserved slugs, Safe Browsing verdicts — and returns
 * a stable error code for each. Re-implementing any of that here would produce a
 * second, weaker opinion that eventually disagrees with the first, so the form
 * validates nothing beyond "there is something in the box" and shows what the API
 * said.
 *
 * The one case worth special handling is a deduplicated create: it returns 200 with
 * an existing slug rather than 201, and a form that reported "created" would leave
 * the user hunting for a second link that was never made.
 */

import type { LinkApiResponse } from "@urlgen/shared";
import { useState, type FormEvent } from "react";

import { CopyButton } from "@/components/copy-button";
import { api, ApiError } from "@/lib/api";

export interface CreateLinkFormProps {
  onCreated: () => void;
}

export function CreateLinkForm({ onCreated }: CreateLinkFormProps) {
  const [url, setUrl] = useState("");
  const [customSlug, setCustomSlug] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [showOptions, setShowOptions] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [created, setCreated] = useState<LinkApiResponse | undefined>(undefined);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (url.trim() === "" || submitting) {
      return;
    }

    setSubmitting(true);
    setError(undefined);
    setCreated(undefined);

    try {
      const link = await api.createLink({ url: url.trim(), customSlug, expiresAt });
      setCreated(link);
      setUrl("");
      setCustomSlug("");
      setExpiresAt("");
      onCreated();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not create the link");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={(event) => {
        void submit(event);
      }}
      className="rounded-lg border border-hairline bg-surface p-4"
    >
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          type="url"
          required
          value={url}
          onChange={(event) => {
            setUrl(event.target.value);
          }}
          placeholder="https://example.com/a-long-url"
          aria-label="URL to shorten"
          className="flex-1 rounded border border-hairline bg-plane px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:border-series-1 focus:outline-none"
        />
        <button
          type="submit"
          disabled={submitting || url.trim() === ""}
          className="rounded bg-series-1 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {submitting ? "Shortening…" : "Shorten"}
        </button>
      </div>

      <button
        type="button"
        onClick={() => {
          setShowOptions((current) => !current);
        }}
        className="mt-2 text-xs text-ink-3 hover:text-ink-2"
      >
        {showOptions ? "Hide options" : "Custom slug or expiry"}
      </button>

      {showOptions && (
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <input
            type="text"
            value={customSlug}
            onChange={(event) => {
              setCustomSlug(event.target.value);
            }}
            placeholder="custom-slug (optional)"
            aria-label="Custom slug"
            className="flex-1 rounded border border-hairline bg-plane px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:border-series-1 focus:outline-none"
          />
          <input
            type="datetime-local"
            value={expiresAt}
            onChange={(event) => {
              setExpiresAt(event.target.value);
            }}
            aria-label="Expires at"
            className="rounded border border-hairline bg-plane px-3 py-2 text-sm text-ink focus:border-series-1 focus:outline-none"
          />
        </div>
      )}

      {error !== undefined && (
        <p role="alert" className="mt-3 text-sm text-critical">
          {error}
        </p>
      )}

      {created !== undefined && (
        <div className="mt-3 flex items-center gap-2 rounded border border-hairline bg-plane px-3 py-2">
          <span className="text-xs text-ink-3">
            {created.deduplicated === true ? "Already shortened" : "Created"}
          </span>
          <code className="flex-1 truncate text-sm text-ink">{created.shortUrl}</code>
          <CopyButton value={created.shortUrl} />
        </div>
      )}
    </form>
  );
}
