// core/state.ts — Centralized application state and selection store
import { AppState, PlanModel, RenderOptions } from "../types/index.js";

export const state: AppState = {
  model: null,
  selected: null,
  opts: {
    showAssoc: false,
    showUnsup: true,
    showUtility: false,
    edges: "select",
    mode: "all",
    render: "diagram",
    action: null,
    pulse: true,
    showLlm: true
  },
  nodeEls: {},
  suppressClick: false
};

export type SelectListener = (selected: string | null) => void;
export type RenderListener = (model: PlanModel | null, opts: RenderOptions) => void;
export type ModeListener = (mode: string) => void;

const selectListeners: SelectListener[] = [];
const renderListeners: RenderListener[] = [];
const modeListeners: ModeListener[] = [];

export function onSelect(fn: SelectListener): void {
  if (typeof fn === "function") selectListeners.push(fn);
}

export function notifySelect(selected: string | null): void {
  selectListeners.forEach(fn => {
    try { fn(selected); } catch (e) { console.error("Error in selectListener:", e); }
  });
}

export function onRender(fn: RenderListener): void {
  if (typeof fn === "function") renderListeners.push(fn);
}

export function notifyRender(model?: PlanModel | null, opts?: RenderOptions): void {
  const m = model !== undefined ? model : state.model;
  const o = opts !== undefined ? opts : state.opts;
  renderListeners.forEach(fn => {
    try { fn(m, o); } catch (e) { console.error("Error in renderListener:", e); }
  });
}

export function onMode(fn: ModeListener): void {
  if (typeof fn === "function") modeListeners.push(fn);
}

export function notifyMode(m: string): void {
  modeListeners.forEach(fn => {
    try { fn(m); } catch (e) { console.error("Error in modeListener:", e); }
  });
}

export function setMode(m: string): string {
  state.opts.mode = m;
  notifyMode(m);
  return m;
}

export function getModel(): PlanModel | null {
  return state.model;
}

export function setModel(m: PlanModel | null): PlanModel | null {
  state.model = m;
  return state.model;
}

export function getSelected(): string | null {
  return state.selected;
}

export function setSelected(s: string | null): string | null {
  state.selected = s;
  return state.selected;
}

export function getOpts(): RenderOptions {
  return state.opts;
}

export function setOpts(newOpts: Partial<RenderOptions>): RenderOptions {
  Object.assign(state.opts, newOpts);
  return state.opts;
}

export function getNodeEls(): Record<string, HTMLElement> {
  return state.nodeEls;
}

export function setNodeEls(els: Record<string, HTMLElement>): Record<string, HTMLElement> {
  state.nodeEls = els;
  return state.nodeEls;
}

export function setSuppressClick(val: boolean): boolean {
  state.suppressClick = !!val;
  return state.suppressClick;
}

