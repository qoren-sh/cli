import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QorenError, type DesignInput, type DesignSummary } from "@qoren/sdk";
import { describe, expect, it } from "vitest";
import { designerRefusal } from "../context.js";
import { EXIT_ERROR, EXIT_PAYMENT } from "../output.js";
import {
  bindInputs,
  findDesign,
  matchDesign,
  mergeBindings,
  parseVersion,
  parseVersionRef,
  readSpecFile,
} from "./designer.js";

const design = (over: Partial<DesignSummary>): DesignSummary => ({
  designId: "d1",
  name: "Lead catcher",
  description: null,
  icon: null,
  starterSlug: null,
  latestVersion: 1,
  instanceCount: 0,
  createdBy: "u1",
  createdAt: 0,
  updatedAt: 0,
  archivedAt: null,
  ...over,
});

describe("findDesign", () => {
  const leads = design({ designId: "d1", name: "Lead catcher" });
  const support = design({ designId: "d2", name: "Support desk" });
  const old = design({ designId: "d3", name: "Old leads", archivedAt: 1 });

  it("matches an id, an exact name, then the name's slug", () => {
    expect(findDesign([leads, support], "d2")).toBe(support);
    expect(findDesign([leads, support], "Lead catcher")).toBe(leads);
    expect(findDesign([leads, support], "lead-catcher")).toBe(leads);
  });

  it("reaches an archived design only by id", () => {
    expect(findDesign([old], "Old leads")).toBeNull();
    expect(findDesign([old], "d3")).toBe(old);
  });

  it("refuses to guess between namesakes, and says what to run when nothing matches", () => {
    const twin = design({ designId: "d9", name: "Lead catcher" });
    expect(() => findDesign([leads, twin], "Lead catcher")).toThrow(/more than one/i);
    expect(() => matchDesign([leads], "nope")).toThrow(/qoren designer ls/);
  });
});

describe("parseVersionRef", () => {
  it("reads draft, latest and version numbers, with or without a v", () => {
    expect(parseVersionRef("draft")).toBe("draft");
    expect(parseVersionRef("LATEST")).toBe("latest");
    expect(parseVersionRef("3")).toBe(3);
    expect(parseVersionRef("v12")).toBe(12);
  });

  it("refuses anything else, and a bare word where a number is needed", () => {
    expect(() => parseVersionRef("0")).toThrow();
    expect(() => parseVersionRef("2.5")).toThrow();
    expect(() => parseVersion("latest")).toThrow(/version number/);
  });
});

describe("bindInputs", () => {
  const inputs: DesignInput[] = [
    { key: "tone", label: "Tone", kind: "text", required: true },
    { key: "max", label: "Max", kind: "number", required: false },
    { key: "urgent", label: "Urgent", kind: "boolean", required: false },
    { key: "tags", label: "Tags", kind: "select", required: false, multiple: true },
    { key: "crm", label: "CRM key", kind: "secret", required: true },
    { key: "slack", label: "Slack", kind: "connection", required: false },
    { key: "kbs", label: "Knowledge", kind: "knowledge_base", required: false, multiple: true },
  ];

  it("routes each input by its kind and types scalars", () => {
    expect(
      bindInputs(inputs, [
        "tone=warm, but brief",
        "max=5",
        "urgent=on",
        "tags=a, b",
        "crm=HUBSPOT_TOKEN",
        "slack=ch_1",
        "kbs=kb1,kb2",
      ]),
    ).toEqual({
      bindings: { tone: "warm, but brief", max: 5, urgent: true, tags: ["a", "b"] },
      secretBindings: { crm: "HUBSPOT_TOKEN" },
      resourceBindings: { slack: "ch_1", kbs: ["kb1", "kb2"] },
    });
  });

  it("clears an input given no value, and keeps an = inside the value", () => {
    expect(bindInputs(inputs, ["tone=", "tags=x=y"]).bindings).toEqual({
      tone: null,
      tags: ["x=y"],
    });
  });

  it("names the inputs that exist when a key is wrong, and refuses bad values", () => {
    expect(() => bindInputs(inputs, ["nope=1"])).toThrow(/tone, max/);
    expect(() => bindInputs(inputs, ["max=lots"])).toThrow(/number/);
    expect(() => bindInputs(inputs, ["urgent=maybe"])).toThrow(/on or off/);
    expect(() => bindInputs(inputs, ["tone"])).toThrow(/key=value/);
  });
});

describe("mergeBindings", () => {
  const current = {
    bindings: { tone: "warm", max: 3 },
    secretBindings: { crm: "OLD" },
    resourceBindings: { slack: "ch_1" },
  };

  it("treats an agent the Designer has no record of as having nothing yet", () => {
    expect(
      mergeBindings(
        { bindings: null, secretBindings: null, resourceBindings: null },
        { bindings: { max: 5 } },
      ),
    ).toEqual({ bindings: { max: 5 } });
  });

  it("lays changes over what the agent has, and leaves untouched maps out", () => {
    expect(mergeBindings(current, { bindings: { max: 5 } })).toEqual({
      bindings: { tone: "warm", max: 5 },
    });
    expect(mergeBindings(current, { secretBindings: { crm: "NEW" } })).toEqual({
      secretBindings: { crm: "NEW" },
    });
  });
});

describe("readSpecFile", () => {
  const dir = mkdtempSync(join(tmpdir(), "qoren-designer-"));

  it("reads a design spec", () => {
    const path = join(dir, "ok.json");
    writeFileSync(path, JSON.stringify({ kind: "qoren.design", schemaVersion: 1, meta: { name: "X" } }));
    expect(readSpecFile(path).meta.name).toBe("X");
  });

  it("refuses JSON that is not a design, and a file that is not JSON", () => {
    const other = join(dir, "other.json");
    writeFileSync(other, JSON.stringify({ hello: "world" }));
    expect(() => readSpecFile(other)).toThrow(/not a design spec/);
    const broken = join(dir, "broken.json");
    writeFileSync(broken, "{ nope");
    expect(() => readSpecFile(broken)).toThrow(/Could not read/);
  });
});

describe("designerRefusal", () => {
  const refusal = (code: string) =>
    new QorenError("Refused.", 403, { error: "Refused.", code });

  it("treats a plan limit as a plan problem and owner-only as a plain failure", () => {
    expect(designerRefusal(refusal("designer_disabled"))).toBe(EXIT_PAYMENT);
    expect(designerRefusal(refusal("custom_agent_limit"))).toBe(EXIT_PAYMENT);
    expect(designerRefusal(refusal("designer_owner_only"))).toBe(EXIT_ERROR);
  });

  it("leaves every other 403 to the sign-in advice", () => {
    expect(designerRefusal(refusal("something_else"))).toBeNull();
    expect(designerRefusal(new QorenError("Forbidden.", 403))).toBeNull();
  });
});
