import type { Page } from "playwright";
import type { LocatorPlan, LocatorStrategy } from "../artifact/locator.js";

export interface ElementInfo {
  ref: string;
  role: string;
  name: string;
  tag: string;
  type?: string;
  currentValue?: string;
  plan: LocatorPlan;
}

export interface PageSnapshot {
  url: string;
  title: string;
  bodyText: string;
  elements: ElementInfo[];
}

interface RawElement {
  tag: string;
  role: string;
  name: string;
  type?: string;
  value?: string;
  nameAttr?: string;
  cssPath: string;
}

// A source string, not a function: tsx/esbuild would inject a `__name` helper that doesn't exist in the page.
const CAPTURE_ELEMENTS_SCRIPT = `
(() => {
  function implicitRole(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === "a" && el.hasAttribute("href")) return "link";
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      if (t === "submit" || t === "button") return "button";
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "password") return "textbox";
      if (t === "hidden") return "hidden";
      return "textbox";
    }
    return el.getAttribute("role") || tag;
  }

  function accessibleName(el) {
    const aria = el.getAttribute("aria-label");
    if (aria) return aria.trim();
    const tag = el.tagName.toLowerCase();
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "submit" || type === "button") return el.value || "Submit";
      const placeholder = el.getAttribute("placeholder");
      if (placeholder) return placeholder.trim();
      const cell = el.closest("td");
      const prevCell = cell && cell.previousElementSibling;
      if (prevCell && prevCell.tagName.toLowerCase() === "td") {
        return (prevCell.textContent || "").trim();
      }
      return el.getAttribute("name") || "";
    }
    if (tag === "select") {
      const cell = el.closest("td");
      const prevCell = cell && cell.previousElementSibling;
      if (prevCell && prevCell.tagName.toLowerCase() === "td") {
        return (prevCell.textContent || "").trim();
      }
      return el.getAttribute("name") || "";
    }
    return (el.textContent || "").replace(/\\s+/g, " ").trim();
  }

  function cssPath(el) {
    const parts = [];
    let node = el;
    while (node && node.tagName.toLowerCase() !== "body" && parts.length < 6) {
      const parent = node.parentElement;
      if (!parent) break;
      const currentTag = node.tagName;
      const siblings = Array.from(parent.children).filter((c) => c.tagName === currentTag);
      const idx = siblings.indexOf(node) + 1;
      parts.unshift(node.tagName.toLowerCase() + ":nth-of-type(" + idx + ")");
      node = parent;
    }
    return "body " + parts.join(" > ");
  }

  const nodes = Array.from(
    document.querySelectorAll("a[href], button, input:not([type=hidden]), select, textarea")
  );
  return nodes
    .filter((el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    })
    .map((el) => ({
      tag: el.tagName.toLowerCase(),
      role: implicitRole(el),
      name: accessibleName(el),
      type: el.getAttribute("type") || undefined,
      value: el.value || undefined,
      nameAttr: el.getAttribute("name") || undefined,
      cssPath: cssPath(el),
    }));
})()`;

export async function captureSnapshot(page: Page): Promise<PageSnapshot> {
  const raw: RawElement[] = await page.evaluate(CAPTURE_ELEMENTS_SCRIPT);

  const elements: ElementInfo[] = raw.map((r, i) => {
    const strategies: LocatorStrategy[] = [];
    if (r.name) strategies.push({ kind: "role", role: r.role, name: r.name, exact: true });
    if (r.nameAttr && (r.tag === "input" || r.tag === "select" || r.tag === "textarea")) {
      strategies.push({ kind: "formField", name: r.nameAttr });
    }
    if (r.name && (r.role === "link" || r.role === "button")) {
      strategies.push({ kind: "text", text: r.name, exact: true });
    }
    strategies.push({ kind: "css", selector: r.cssPath });

    return {
      ref: `e${i + 1}`,
      role: r.role,
      name: r.name,
      tag: r.tag,
      type: r.type,
      currentValue: r.type === "password" ? undefined : r.value,
      plan: {
        strategies,
        rationale:
          strategies[0]?.kind === "role"
            ? "role+accessible name is stable across re-skins; form-field name attribute and css path kept as fallbacks"
            : "no accessible name available; falling back to form field name / css path",
      },
    };
  });

  const bodyText = await page.evaluate<string>(`document.body.innerText.replace(/\\n{2,}/g, "\\n").trim()`);

  return {
    url: page.url(),
    title: await page.title(),
    bodyText,
    elements,
  };
}

// For the operator console: the same elements, plus live handles so a person acts on exactly what they see.
export async function captureSnapshotWithHandles(
  page: Page
): Promise<{ snapshot: PageSnapshot; handles: Map<string, import("playwright").ElementHandle> }> {
  const snapshot = await captureSnapshot(page);
  const handleList = await page.$$("a[href], button, input:not([type=hidden]), select, textarea");
  const visible: import("playwright").ElementHandle[] = [];
  for (const h of handleList) {
    const box = await h.boundingBox();
    if (box && box.width > 0 && box.height > 0) visible.push(h);
  }
  const handles = new Map<string, import("playwright").ElementHandle>();
  snapshot.elements.forEach((el, i) => {
    const h = visible[i];
    if (h) handles.set(el.ref, h);
  });
  return { snapshot, handles };
}

export function renderSnapshotForPrompt(snap: PageSnapshot): string {
  const lines = snap.elements.map((e) => {
    const extra = e.currentValue ? ` value="${e.currentValue}"` : "";
    return `[${e.ref}] ${e.role} "${e.name}"${extra}`;
  });
  return [
    `URL: ${snap.url}`,
    `TITLE: ${snap.title}`,
    ``,
    `VISIBLE TEXT:`,
    snap.bodyText.slice(0, 2000),
    ``,
    `INTERACTIVE ELEMENTS:`,
    ...lines,
  ].join("\n");
}
