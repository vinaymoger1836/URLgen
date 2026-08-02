import { describe, expect, it } from "vitest";

import {
  assessUrlSafety,
  classifyHost,
  isPunycodeHost,
  normalizeHost,
  parseIpv4,
  parseIpv6,
} from "./safety.js";

describe("parseIpv4", () => {
  it("parses dotted decimal", () => {
    expect(parseIpv4("192.168.1.1")).toEqual([192, 168, 1, 1]);
    expect(parseIpv4("0.0.0.0")).toEqual([0, 0, 0, 0]);
    expect(parseIpv4("255.255.255.255")).toEqual([255, 255, 255, 255]);
  });

  it("rejects anything that is not four in-range octets", () => {
    expect(parseIpv4("1.2.3")).toBeUndefined();
    expect(parseIpv4("1.2.3.4.5")).toBeUndefined();
    expect(parseIpv4("256.1.1.1")).toBeUndefined();
    expect(parseIpv4("1.2.3.a")).toBeUndefined();
    expect(parseIpv4("example.com")).toBeUndefined();
  });
});

describe("parseIpv6", () => {
  it("expands the :: compression", () => {
    expect(parseIpv6("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6("::")).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(parseIpv6("fe80::1")).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
  });

  it("parses a full uncompressed address", () => {
    expect(parseIpv6("2001:db8:0:0:0:0:0:1")).toEqual([0x2001, 0x0db8, 0, 0, 0, 0, 0, 1]);
  });

  it("parses an embedded dotted quad", () => {
    expect(parseIpv6("::ffff:127.0.0.1")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 0x0001]);
  });

  it("ignores a zone identifier", () => {
    expect(parseIpv6("fe80::1%eth0")).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
  });

  it("rejects malformed input", () => {
    expect(parseIpv6("example.com")).toBeUndefined();
    expect(parseIpv6("1::2::3")).toBeUndefined();
    expect(parseIpv6("gggg::1")).toBeUndefined();
    expect(parseIpv6("1:2:3:4:5:6:7")).toBeUndefined();
  });
});

describe("normalizeHost", () => {
  it("lowercases, strips the fully-qualified trailing dot and IPv6 brackets", () => {
    expect(normalizeHost("EXAMPLE.com")).toBe("example.com");
    expect(normalizeHost("localhost.")).toBe("localhost");
    expect(normalizeHost("example.com..")).toBe("example.com");
    expect(normalizeHost("[::1]")).toBe("::1");
  });
});

describe("classifyHost", () => {
  it("treats ordinary domains and public IPs as public", () => {
    expect(classifyHost("example.com")).toBe("public");
    expect(classifyHost("sub.example.co.uk")).toBe("public");
    expect(classifyHost("8.8.8.8")).toBe("public");
    expect(classifyHost("2606:4700::1111")).toBe("public");
  });

  it("identifies every private IPv4 range", () => {
    expect(classifyHost("10.0.0.1")).toBe("private");
    expect(classifyHost("172.16.0.1")).toBe("private");
    expect(classifyHost("172.31.255.255")).toBe("private");
    expect(classifyHost("192.168.1.1")).toBe("private");
    /* 172.15 and 172.32 are outside the /12 and must stay public. */
    expect(classifyHost("172.15.0.1")).toBe("public");
    expect(classifyHost("172.32.0.1")).toBe("public");
  });

  it("identifies loopback, unspecified and link-local", () => {
    expect(classifyHost("127.0.0.1")).toBe("loopback");
    expect(classifyHost("127.255.255.254")).toBe("loopback");
    expect(classifyHost("0.0.0.0")).toBe("unspecified");
    expect(classifyHost("169.254.1.1")).toBe("link-local");
  });

  it("blocks the cloud metadata endpoint", () => {
    expect(classifyHost("169.254.169.254")).toBe("link-local");
  });

  it("identifies CGNAT, multicast and reserved space", () => {
    expect(classifyHost("100.64.0.1")).toBe("carrier-grade-nat");
    expect(classifyHost("224.0.0.1")).toBe("multicast");
    expect(classifyHost("240.0.0.1")).toBe("reserved");
    expect(classifyHost("255.255.255.255")).toBe("reserved");
    expect(classifyHost("192.0.2.1")).toBe("reserved");
    expect(classifyHost("198.51.100.1")).toBe("reserved");
    expect(classifyHost("203.0.113.1")).toBe("reserved");
  });

  it("classifies IPv6 loopback, ULA, link-local and multicast", () => {
    expect(classifyHost("::1")).toBe("loopback");
    expect(classifyHost("[::1]")).toBe("loopback");
    expect(classifyHost("::")).toBe("unspecified");
    expect(classifyHost("fc00::1")).toBe("private");
    expect(classifyHost("fd12:3456::1")).toBe("private");
    expect(classifyHost("fe80::1")).toBe("link-local");
    expect(classifyHost("ff02::1")).toBe("multicast");
    expect(classifyHost("2001:db8::1")).toBe("reserved");
  });

  it("judges IPv4-mapped IPv6 by the address inside it", () => {
    expect(classifyHost("::ffff:127.0.0.1")).toBe("loopback");
    expect(classifyHost("::ffff:7f00:1")).toBe("loopback");
    expect(classifyHost("::ffff:192.168.1.1")).toBe("private");
    expect(classifyHost("::ffff:169.254.169.254")).toBe("link-local");
    expect(classifyHost("::ffff:8.8.8.8")).toBe("public");
  });

  it("blocks machine-local hostnames", () => {
    expect(classifyHost("localhost")).toBe("local-hostname");
    expect(classifyHost("LOCALHOST.")).toBe("local-hostname");
    expect(classifyHost("printer.local")).toBe("local-hostname");
    expect(classifyHost("db.internal")).toBe("local-hostname");
    expect(classifyHost("host.home.arpa")).toBe("local-hostname");
    expect(classifyHost("api.lan")).toBe("local-hostname");
  });

  it("blocks bare single-label hosts, which only resolve via a local search domain", () => {
    expect(classifyHost("intranet")).toBe("local-hostname");
    expect(classifyHost("wiki")).toBe("local-hostname");
  });
});

describe("isPunycodeHost", () => {
  it("detects internationalized labels", () => {
    expect(isPunycodeHost("xn--pple-43d.com")).toBe(true);
    expect(isPunycodeHost("shop.xn--80ak6aa92e.com")).toBe(true);
    expect(isPunycodeHost("example.com")).toBe(false);
  });
});

describe("assessUrlSafety", () => {
  it("accepts an ordinary public URL", () => {
    const result = assessUrlSafety("https://example.com/article?id=7");

    expect(result.safe).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.classification).toBe("public");
    expect(result.punycode).toBe(false);
  });

  it("rejects obfuscated encodings of loopback, which the URL parser normalizes for us", () => {
    /* Decimal, hex, octal and short-form all resolve to 127.0.0.1 before we see them. */
    for (const hostile of [
      "http://127.0.0.1/",
      "http://2130706433/",
      "http://0x7f000001/",
      "http://0177.0.0.1/",
      "http://127.1/",
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
    ]) {
      const result = assessUrlSafety(hostile);
      expect(result.safe, hostile).toBe(false);
      expect(result.issues, hostile).toContain("non-public-host");
    }
  });

  it("rejects the AWS metadata endpoint", () => {
    const result = assessUrlSafety("http://169.254.169.254/latest/meta-data/iam/");

    expect(result.safe).toBe(false);
    expect(result.classification).toBe("link-local");
  });

  it("rejects private network destinations", () => {
    for (const hostile of [
      "http://192.168.1.1/admin",
      "http://10.1.2.3/",
      "http://172.20.0.5/",
      "https://router.local/",
      "http://intranet/",
    ]) {
      expect(assessUrlSafety(hostile).safe, hostile).toBe(false);
    }
  });

  it("rejects non-web schemes and malformed input", () => {
    expect(assessUrlSafety("javascript:alert(1)").issues).toContain("unsupported-protocol");
    expect(assessUrlSafety("file:///etc/passwd").issues).toContain("unsupported-protocol");
    expect(assessUrlSafety("not a url").issues).toContain("malformed");
    expect(assessUrlSafety("/relative").issues).toContain("malformed");
  });

  it("rejects embedded credentials", () => {
    expect(assessUrlSafety("https://user:pass@example.com/").issues).toContain(
      "embedded-credentials",
    );
  });

  it("rejects a URL longer than the limit", () => {
    const long = `https://example.com/${"a".repeat(2100)}`;
    expect(assessUrlSafety(long).issues).toContain("too-long");
  });

  it("rejects shortening our own domain, which would build a redirect loop", () => {
    const result = assessUrlSafety("https://urlgen.dev/abc123", {
      ownHosts: ["urlgen.dev", "localhost:8787"],
    });

    expect(result.safe).toBe(false);
    expect(result.issues).toContain("self-referential");
  });

  it("matches own hosts ignoring port and case", () => {
    expect(
      assessUrlSafety("http://LOCALHOST:8787/x", { ownHosts: ["localhost:8787"] }).issues,
    ).toContain("self-referential");
  });

  it("leaves an unrelated host alone when own hosts are configured", () => {
    expect(assessUrlSafety("https://example.com/", { ownHosts: ["urlgen.dev"] }).safe).toBe(true);
  });

  it("flags but does not reject internationalized domains", () => {
    /* A Cyrillic 'а' reaches us already punycode-encoded by the URL parser. */
    const result = assessUrlSafety("https://аpple.com/");

    expect(result.punycode).toBe(true);
    expect(result.hostname).toBe("xn--pple-43d.com");
    expect(result.safe).toBe(true);
  });

  it("reports every issue at once rather than stopping at the first", () => {
    const result = assessUrlSafety("http://user:pw@127.0.0.1/");

    expect(result.issues).toContain("embedded-credentials");
    expect(result.issues).toContain("non-public-host");
  });
});
