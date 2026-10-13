// Tiny DOM helpers. No framework.
type Child = Node | string | number | null | undefined | false | Child[];
type Attrs = Record<string, unknown>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
    else if (k === "class") el.className = String(v);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k === "value") (el as HTMLInputElement).value = String(v);
    else if (k === "checked") (el as HTMLInputElement).checked = Boolean(v);
    else if (k === "selected") (el as HTMLOptionElement).selected = Boolean(v);
    else if (k === "disabled") (el as HTMLInputElement).disabled = Boolean(v);
    else if (k === "dataset" && typeof v === "object") Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  append(el, children);
  return el;
}

function append(el: Node, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
  }
}

export function mount(target: HTMLElement, ...children: Child[]) {
  target.replaceChildren();
  append(target, children);
}

export function select(id: string, value: number | string, options: [number | string, string][], onchange: (v: string) => void, attrs: Attrs = {}) {
  return h("select", { id, ...attrs, onchange: (e: Event) => onchange((e.target as HTMLSelectElement).value) },
    options.map(([v, label]) => h("option", { value: v, selected: String(v) === String(value) }, label)));
}

export function num(id: string, value: number, min: number, max: number, onchange: (v: number) => void, attrs: Attrs = {}) {
  return h("input", {
    id, type: "number", inputmode: "numeric", min, max, value, ...attrs,
    onchange: (e: Event) => {
      const t = e.target as HTMLInputElement;
      let v = Math.trunc(Number(t.value));
      if (!Number.isFinite(v)) v = value;
      v = Math.max(min, Math.min(max, v));
      t.value = String(v);
      onchange(v);
    },
  });
}

export function field(label: string, forId: string, control: Node, hint?: string | Node) {
  return h("div", { class: "field" }, h("label", { for: forId }, label), control, hint ? h("div", { class: "hint" }, hint) : null);
}
