import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { embeddedLauncher, renewLauncher } from "./launcher-renewal.js";

const OLD = "#!/usr/bin/env node\n// the launcher from an earlier release\n";
const NEW = "#!/usr/bin/env node\n// the launcher this runtime was built with\n";

let home: string;
let installed: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mesh-launcher-"));
  installed = join(home, ".mesh", "bin", "mesh");
  mkdirSync(dirname(installed), { recursive: true });
  writeFileSync(installed, OLD, { mode: 0o755 });
});

describe("renewLauncher — an update reaches the launcher too", () => {
  it("replaces an out-of-date installed launcher and keeps it executable", () => {
    expect(renewLauncher({ source: NEW, startedBy: installed, installedPath: installed })).toBe("renewed");
    expect(readFileSync(installed, "utf8")).toBe(NEW);
    expect(statSync(installed).mode & 0o111).not.toBe(0);
    // Nothing is left beside it.
    expect(readdirSync(dirname(installed))).toEqual(["mesh"]);
  });

  it("leaves a launcher that already matches alone", () => {
    writeFileSync(installed, NEW, { mode: 0o755 });
    const before = statSync(installed).mtimeMs;
    expect(renewLauncher({ source: NEW, startedBy: installed, installedPath: installed })).toBe("current");
    expect(statSync(installed).mtimeMs).toBe(before);
  });

  it("follows a symlink to the installed launcher", () => {
    const link = join(home, "mesh-link");
    symlinkSync(installed, link);
    expect(renewLauncher({ source: NEW, startedBy: link, installedPath: installed })).toBe("renewed");
    expect(readFileSync(installed, "utf8")).toBe(NEW);
  });

  it("never touches a launcher saved somewhere else", () => {
    const elsewhere = join(home, "Downloads", "mesh");
    mkdirSync(dirname(elsewhere), { recursive: true });
    writeFileSync(elsewhere, OLD, { mode: 0o755 });
    expect(renewLauncher({ source: NEW, startedBy: elsewhere, installedPath: installed })).toBe("not-applicable");
    expect(readFileSync(elsewhere, "utf8")).toBe(OLD);
    expect(readFileSync(installed, "utf8")).toBe(OLD);
  });

  it("does nothing when the runtime was not started by a launcher, or carries none", () => {
    expect(renewLauncher({ source: NEW, startedBy: undefined, installedPath: installed })).toBe("not-applicable");
    expect(renewLauncher({ source: NEW, startedBy: "", installedPath: installed })).toBe("not-applicable");
    expect(renewLauncher({ source: undefined, startedBy: installed, installedPath: installed })).toBe("not-applicable");
    expect(renewLauncher({ source: NEW, startedBy: join(home, "missing"), installedPath: installed })).toBe("not-applicable");
    expect(readFileSync(installed, "utf8")).toBe(OLD);
  });

  it("a developer run carries no launcher, so it can never rewrite one", () => {
    expect(embeddedLauncher()).toBeUndefined();
    expect(existsSync(installed)).toBe(true);
  });
});
