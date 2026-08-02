import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { LinkRecord } from "@urlgen/shared";
import { describe, expect, it, vi } from "vitest";

import {
  DynamoLinkRepository,
  isConditionalCheckFailure,
  toItem,
  toLinkRecord,
  toTtlSeconds,
} from "./dynamo-link-repository.js";
import { SlugAllocationError, SlugUnavailableError } from "./link-repository.js";

const RECORD: LinkRecord = {
  slug: "abc1234",
  targetUrl: "https://example.com/a",
  ownerId: "alice",
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  urlHash: "deadbeef",
  clickCount: 0,
};

/** The error shape DynamoDB raises when a conditional write loses its race. */
function conditionalFailure(): Error {
  const error = new Error("The conditional request failed");
  error.name = "ConditionalCheckFailedException";
  return error;
}

function repositoryWith(send: ReturnType<typeof vi.fn>, generateSlugFn: () => string) {
  const client = { send } as unknown as DynamoDBDocumentClient;
  return new DynamoLinkRepository({
    client,
    tableName: "urlgen-links-test",
    generateSlugFn,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });
}

describe("toTtlSeconds", () => {
  it("converts to epoch SECONDS, which is what DynamoDB TTL requires", () => {
    expect(toTtlSeconds("2030-01-01T00:00:00.000Z")).toBe(
      Math.floor(Date.parse("2030-01-01T00:00:00.000Z") / 1000),
    );
  });

  it("produces a value far smaller than milliseconds, guarding against the classic mix-up", () => {
    const seconds = toTtlSeconds("2030-01-01T00:00:00.000Z");
    expect(seconds).toBeLessThan(Date.parse("2030-01-01T00:00:00.000Z") / 100);
  });
});

describe("toItem", () => {
  it("derives the primary key and both index keys", () => {
    const item = toItem(RECORD);

    expect(item["pk"]).toBe("LINK#abc1234");
    expect(item["sk"]).toBe("META");
    expect(item["gsi1pk"]).toBe("HASH#deadbeef");
    expect(item["gsi2pk"]).toBe("USER#alice");
    expect(item["gsi2sk"]).toBe(RECORD.createdAt);
  });

  it("adds ttl only when the link expires", () => {
    expect(toItem(RECORD)["ttl"]).toBeUndefined();
    expect(toItem({ ...RECORD, expiresAt: "2030-01-01T00:00:00.000Z" })["ttl"]).toBe(
      toTtlSeconds("2030-01-01T00:00:00.000Z"),
    );
  });
});

describe("toLinkRecord", () => {
  it("strips the storage keys and returns the domain record", () => {
    expect(toLinkRecord(toItem(RECORD))).toEqual(RECORD);
  });

  it("throws rather than returning a half-populated record when the item is corrupt", () => {
    expect(() => toLinkRecord({ pk: "LINK#x", sk: "META" })).toThrow(/does not match/);
    expect(() => toLinkRecord({ ...toItem(RECORD), status: "bogus" })).toThrow(/does not match/);
  });
});

describe("isConditionalCheckFailure", () => {
  it("recognises the DynamoDB conditional failure and nothing else", () => {
    expect(isConditionalCheckFailure(conditionalFailure())).toBe(true);
    expect(isConditionalCheckFailure(new Error("network"))).toBe(false);
    expect(isConditionalCheckFailure(undefined)).toBe(false);
    expect(isConditionalCheckFailure("ConditionalCheckFailedException")).toBe(false);
  });
});

describe("slug allocation", () => {
  const input = {
    targetUrl: "https://example.com/a",
    ownerId: "alice",
    urlHash: "deadbeef",
  };

  it("writes with attribute_not_exists so the uniqueness check is atomic", async () => {
    const send = vi.fn().mockResolvedValue({});
    const repository = repositoryWith(send, () => "abc1234");

    await repository.create(input);

    const command = send.mock.calls[0]?.[0] as { input: Record<string, unknown> };
    expect(command.input["ConditionExpression"]).toBe("attribute_not_exists(pk)");
  });

  it("draws a new slug when the conditional write loses the race", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(conditionalFailure())
      .mockRejectedValueOnce(conditionalFailure())
      .mockResolvedValue({});
    const slugs = ["collide1", "collide2", "winner1"];
    let index = 0;
    const repository = repositoryWith(send, () => slugs[index++] ?? "fallback");

    const record = await repository.create(input);

    expect(record.slug).toBe("winner1");
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("gives up after the configured attempts instead of looping forever", async () => {
    const send = vi.fn().mockRejectedValue(conditionalFailure());
    const client = { send } as unknown as DynamoDBDocumentClient;
    const repository = new DynamoLinkRepository({
      client,
      tableName: "t",
      slugAttempts: 3,
      generateSlugFn: () => "always-the-same",
    });

    await expect(repository.create(input)).rejects.toBeInstanceOf(SlugAllocationError);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("does not retry a custom slug — a taken one is the caller's problem", async () => {
    const send = vi.fn().mockRejectedValue(conditionalFailure());
    const repository = repositoryWith(send, () => "unused");

    await expect(repository.create({ ...input, customSlug: "taken" })).rejects.toBeInstanceOf(
      SlugUnavailableError,
    );
    expect(send).toHaveBeenCalledOnce();
  });

  it("propagates a genuine failure instead of mistaking it for a collision", async () => {
    const send = vi.fn().mockRejectedValue(new Error("ProvisionedThroughputExceeded"));
    const repository = repositoryWith(send, () => "abc1234");

    await expect(repository.create(input)).rejects.toThrow("ProvisionedThroughputExceeded");
    expect(send).toHaveBeenCalledOnce();
  });
});

describe("findSlugByUrlHash", () => {
  it("recovers the slug from the KEYS_ONLY index projection", async () => {
    const send = vi.fn().mockResolvedValue({ Items: [{ pk: "LINK#abc1234", sk: "META" }] });
    const repository = repositoryWith(send, () => "unused");

    await expect(repository.findSlugByUrlHash("deadbeef")).resolves.toBe("abc1234");
  });

  it("returns undefined when nothing matches", async () => {
    const send = vi.fn().mockResolvedValue({ Items: [] });
    const repository = repositoryWith(send, () => "unused");

    await expect(repository.findSlugByUrlHash("deadbeef")).resolves.toBeUndefined();
  });
});
