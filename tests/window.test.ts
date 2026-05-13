import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { pickBaseURL, pickKioskKey, readAptevaInjection } from "../src";

// Bun's test env doesn't have a DOM by default; we manually seed a
// minimal window shape, then tear it down so suites don't leak.
const realWindow = (globalThis as any).window;

function seedWindow(href: string, injection?: Record<string, unknown>): void {
  (globalThis as any).window = {
    location: { href },
    __APTEVA_APP__: injection,
  };
}

function unseedWindow(): void {
  if (realWindow === undefined) {
    delete (globalThis as any).window;
  } else {
    (globalThis as any).window = realWindow;
  }
}

beforeEach(() => unseedWindow());
afterEach(() => unseedWindow());

describe("readAptevaInjection", () => {
  test("returns undefined when no window", () => {
    expect(readAptevaInjection()).toBeUndefined();
  });

  test("returns injection when window.__APTEVA_APP__ set", () => {
    seedWindow("https://app.example.com/", {
      app_name: "flexylead",
      install_id: 42,
      kiosk_api_key: "sk-kiosk",
    });
    const inj = readAptevaInjection()!;
    expect(inj.app_name).toBe("flexylead");
    expect(inj.install_id).toBe(42);
  });
});

describe("pickKioskKey", () => {
  test("URL ?api_key=… wins over install config", () => {
    seedWindow("https://app.example.com/?api_key=sk-from-url", {
      kiosk_api_key: "sk-from-install",
    });
    expect(pickKioskKey()).toBe("sk-from-url");
  });

  test("install config wins over fallback", () => {
    seedWindow("https://app.example.com/", { kiosk_api_key: "sk-from-install" });
    expect(pickKioskKey("sk-from-env")).toBe("sk-from-install");
  });

  test("fallback used when no window key", () => {
    seedWindow("https://app.example.com/", {});
    expect(pickKioskKey("sk-from-env")).toBe("sk-from-env");
  });

  test("undefined when nothing set", () => {
    seedWindow("https://app.example.com/", {});
    expect(pickKioskKey()).toBeUndefined();
  });

  test("works without window (Node/SSR)", () => {
    expect(pickKioskKey()).toBeUndefined();
    expect(pickKioskKey("sk-env")).toBe("sk-env");
  });
});

describe("pickBaseURL", () => {
  test("explicit arg wins", () => {
    seedWindow("https://app.example.com/", { api_base: "/api" });
    expect(pickBaseURL("https://override.example.com")).toBe(
      "https://override.example.com",
    );
  });

  test("strips /api suffix from __APTEVA_APP__.api_base", () => {
    seedWindow("https://app.example.com/", { api_base: "/api" });
    expect(pickBaseURL()).toBe("");
  });

  test("strips /api suffix from fully-qualified __API_BASE__", () => {
    (globalThis as any).window = {
      location: { href: "https://app.example.com/" },
      __API_BASE__: "https://srv.example.com/api",
    };
    expect(pickBaseURL()).toBe("https://srv.example.com");
  });

  test("returns empty string when nothing set (same-origin)", () => {
    expect(pickBaseURL()).toBe("");
  });
});
