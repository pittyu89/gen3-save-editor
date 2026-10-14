// A searchable list picker with icons, used instead of native selects wherever options have a
// sprite or a type colour (species, items, balls, moves). Icons are decoded lazily as rows scroll in.
import { h } from "./dom";

export interface PickOption {
  value: number;
  label: string;
  /** Small text before the label, e.g. a dex number. */
  meta?: string;
  /** Type colour for a stripe on the left (moves). */
  type?: string;
  /** Icon as a data URL; called only when the row becomes visible. */
  icon?: () => string | null;
}

export interface PickerOpts {
  title: string;
  options: PickOption[];
  current: number;
  onPick: (v: number) => void;
  iconSize?: "sm" | "lg";
}

const MAX_ROWS = 1200;
let open: { close: () => void } | null = null;

export function closePicker() { open?.close(); }

export function openPicker(o: PickerOpts) {
  closePicker();
  const prevFocus = document.activeElement as HTMLElement | null;
  const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const list = h("ul", { class: "picklist", role: "listbox", "aria-label": o.title });
  const count = h("div", { class: "pickcount muted" });
  let observer: IntersectionObserver | null = null;
  const loadIcon = (el: HTMLElement) => {
    const opt = o.options[Number(el.dataset.i)];
    const url = opt?.icon?.();
    if (url) el.replaceChildren(h("img", { src: url, alt: "", class: "pkimg" }));
    else el.classList.add("none");
  };
  const render = (q: string) => {
    observer?.disconnect();
    const nq = norm(q.trim());
    const idx: number[] = [];
    o.options.forEach((opt, i) => { if (!nq || norm(`${opt.meta ?? ""} ${opt.label}`).includes(nq)) idx.push(i); });
    const shown = idx.slice(0, MAX_ROWS);
    list.replaceChildren(...shown.map(i => {
      const opt = o.options[i];
      return h("li", {
        class: `pickrow ${opt.value === o.current ? "on" : ""}`, role: "option", "aria-selected": opt.value === o.current ? "true" : "false",
        tabindex: "0", "data-type": opt.type ?? "none",
        onclick: () => pick(opt.value),
        onkeydown: (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(opt.value); } },
      },
        opt.icon ? h("span", { class: `pkicon ${o.iconSize ?? "sm"}`, "data-i": String(i), "aria-hidden": "true" }) : null,
        opt.meta ? h("span", { class: "pkmeta mono" }, opt.meta) : null,
        h("span", { class: "pklabel" }, opt.label));
    }));
    count.textContent = idx.length > MAX_ROWS ? `Showing ${MAX_ROWS} of ${idx.length}. Type to narrow it down.` : idx.length ? "" : "No matches.";
    observer = new IntersectionObserver(entries => {
      for (const en of entries) if (en.isIntersecting) { loadIcon(en.target as HTMLElement); observer!.unobserve(en.target); }
    }, { root: list, rootMargin: "200px" });
    list.querySelectorAll<HTMLElement>(".pkicon").forEach(el => observer!.observe(el));
  };
  const search = h("input", {
    class: "picksearch", type: "search", placeholder: "Search", autocomplete: "off", "aria-label": `Search ${o.title}`,
    oninput: (e: Event) => render((e.target as HTMLInputElement).value),
    onkeydown: (e: KeyboardEvent) => {
      if (e.key === "Enter") { const first = list.querySelector<HTMLElement>(".pickrow"); first?.click(); }
      if (e.key === "ArrowDown") { e.preventDefault(); list.querySelector<HTMLElement>(".pickrow")?.focus(); }
    },
  }) as HTMLInputElement;
  const dialog = h("div", { class: "picker", role: "dialog", "aria-modal": "true", "aria-label": o.title },
    h("div", { class: "pickhead" }, h("strong", {}, o.title), h("button", { class: "btn small", onclick: () => close() }, "Close")),
    search, count, list);
  const wrap = h("div", { class: "pickwrap", onclick: (e: Event) => { if (e.target === wrap) close(); } }, dialog);
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  function close() {
    observer?.disconnect();
    wrap.remove();
    document.removeEventListener("keydown", onKey, true);
    document.body.classList.remove("picking");
    open = null;
    prevFocus?.focus?.();
  }
  function pick(v: number) { close(); if (v !== o.current) o.onPick(v); }
  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(wrap);
  document.body.classList.add("picking");
  render("");
  open = { close };
  // jump to the current choice; focus the search only where it won't pop up a phone keyboard
  list.querySelector(".pickrow.on")?.scrollIntoView({ block: "center" });
  if (matchMedia("(pointer: fine)").matches) search.focus();
}

/** The button that shows the current choice and opens the picker. */
export function pickButton(id: string, label: string, opts: { icon?: string | null; type?: string; meta?: string; ariaLabel?: string; onclick: () => void; disabled?: boolean }) {
  return h("button", {
    id, type: "button", class: `pickbtn ${opts.type ? "typed" : ""}`, "data-type": opts.type ?? "none", disabled: opts.disabled,
    "aria-haspopup": "listbox", "aria-label": opts.ariaLabel, onclick: opts.onclick,
  },
    opts.icon !== undefined ? (opts.icon ? h("img", { src: opts.icon, alt: "", class: "pbicon" }) : h("span", { class: "pbicon none", "aria-hidden": "true" })) : null,
    opts.meta ? h("span", { class: "pkmeta mono" }, opts.meta) : null,
    h("span", { class: "pblabel" }, label),
    h("span", { class: "pbchev", "aria-hidden": "true" }, "▾"));
}
