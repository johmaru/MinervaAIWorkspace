// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isIPInList } from "@/lib/ip-cidr";

describe("isIPInList", () => {
  it("matches exact IPv4", () => {
    expect(isIPInList("192.168.1.50", "192.168.1.50")).toBe(true);
  });

  it("matches IPv4 within CIDR", () => {
    expect(isIPInList("10.0.0.5", "10.0.0.0/8")).toBe(true);
  });

  it("does not match IPv4 outside CIDR", () => {
    expect(isIPInList("192.168.1.5", "10.0.0.0/8")).toBe(false);
  });

  it("does not match non-listed exact IP", () => {
    expect(isIPInList("10.0.0.5", "192.168.1.50")).toBe(false);
  });

  it("silently skips invalid CIDR entries", () => {
    expect(isIPInList("10.0.0.5", "garbage,10.0.0.0/8")).toBe(true);
  });

  it("returns false for empty list", () => {
    expect(isIPInList("10.0.0.5", "")).toBe(false);
  });

  it("matches first of multiple entries", () => {
    expect(isIPInList("10.0.0.5", "10.0.0.5,192.168.1.0/24")).toBe(true);
  });

  it("matches second entry via CIDR", () => {
    expect(isIPInList("192.168.1.100", "10.0.0.5,192.168.1.0/24")).toBe(true);
  });

  it("returns false for invalid request IP", () => {
    expect(isIPInList("not-an-ip", "10.0.0.0/8")).toBe(false);
  });

  it("rejects CIDR prefix > 32 for IPv4", () => {
    expect(isIPInList("10.0.0.5", "10.0.0.0/99")).toBe(false);
  });

  it("matches exact IPv6", () => {
    expect(isIPInList("::1", "::1")).toBe(true);
  });

  it("does not match different IPv6", () => {
    expect(isIPInList("::1", "::2")).toBe(false);
  });

  it("matches IPv6 within CIDR", () => {
    expect(isIPInList("fe80::1", "fe80::/10")).toBe(true);
  });

  it("does not match IPv6 outside CIDR", () => {
    expect(isIPInList("2001:db8::1", "fe80::/10")).toBe(false);
  });
});
