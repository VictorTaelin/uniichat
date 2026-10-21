// Pick
// ====
// What a chat's calls run on, kept in its log: a vendor (claude-api,
// openai-api), a model of its, an effort and a speed; label
// vendor:model:effort:speed. A chat that saved none takes the config's
// (`def`). A move steps one part along the picks that differ in it
// (`options`), wrapping (up and down stop at the ends): next, prev and
// model every vendor's models, effort, speed (a model lacking one takes
// its fastest below), up and down the efforts, never the speed; given a
// value (`to`), to the pick whose part it is. A saved pick the server
// doesn't offer gives way to def, never to a pick like it. A profile
// (config `profiles`) is a pick too, first in the model's list: a name
// and the models it ranks; picked, it runs on its first, and a call
// goes on with the next as one fails (AskAI.ts), each at the pick's
// effort and speed unless it names its own. A model picked has no
// fallback.

import type { Vendor } from "./AskAI.ts";

// Types
// =====

// model: by its label; profile: the profile picked (its first model)
export type Pick = {
  vendor   : Vendor;
  model    : string;
  effort   : string;
  speed    : string;
  profile? : string;
};

// a key's change to the pick
export type Move = "next" | "prev" | "model" | "up" | "down" | "effort" | "speed";

// a model: as shown, as the vendor names it, its speeds
export type Model = { label: string; id: string; speeds: string[] };

// what a server offers: vendors, models by label, profiles by name
export type Offer = { vendors: Vendor[]; models: string[]; profiles?: Record<string, Fall[]> };

// a profile's model: the effort and speed it names (none: the pick's)
export type Fall = { vendor: Vendor; model: Model; effort?: string; speed?: string };

// Constants
// =========

export const VENDORS: Vendor[] = ["claude-api", "openai-api"];

const OPUS  : Model = { label: "opus-5.5",   id: "claude-opus-5-5",   speeds: ["slow", "fast"] };
const SONNET: Model = { label: "sonnet-5.5", id: "claude-sonnet-5-5", speeds: ["slow"] };
const HAIKU : Model = { label: "haiku-5.5",  id: "claude-haiku-5-5",  speeds: ["slow"] };
const OPENAI: Model[] = [
  { label: "gpt-6-luna",  id: "gpt-6-luna",  speeds: ["slow", "fast"] },
  { label: "gpt-6.1-sol", id: "gpt-6.1-sol", speeds: ["slow", "fast"] },
  { label: "gpt-6-astra", id: "gpt-6-astra", speeds: ["slow", "fast", "ultrafast"] },
];

// each vendor's models, at the speeds it runs them
const MODELS: Record<Vendor, Model[]> = {
  "claude-api": [OPUS, SONNET, HAIKU],
  "openai-api": OPENAI,
};

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

const SPEEDS = ["slow", "fast", "ultrafast"];

export const LABELS = [...new Set(Object.values(MODELS).flat().map((m) => m.label))];

// Pick
// ====

export namespace Pick {

  export function model(vendor: Vendor, label: string): Model | undefined {
    return MODELS[vendor].find((m) => m.label === label);
  }

  export function on(pick: Pick, vendor: Vendor, model: Model): Pick {
    const below = SPEEDS.slice(0, SPEEDS.indexOf(pick.speed) + 1);
    const speed = below.filter((s) => model.speeds.includes(s)).pop() ?? "slow";
    return { ...pick, vendor, model: model.label, speed };
  }

  // the models offered (by label) of these vendors, each with its vendor
  export function models(vendors: Vendor[], labels: string[]): Array<[Vendor, Model]> {
    return vendors.flatMap((v) => MODELS[v].filter((m) => labels.includes(m.label)).map((m): [Vendor, Model] => [v, m]));
  }

  // each with the part the move steps
  export function options(pick: Pick, move: Move, offer: Offer): Array<[string, Pick]> {
    const speeds = Pick.model(pick.vendor, pick.model)?.speeds ?? [];
    const { profile: _, ...plain } = pick;
    const all = Pick.models(offer.vendors, offer.models).map(([v, m]): [string, Pick] => [m.label, Pick.on(plain, v, m)]);
    const profiles = Object.keys(offer.profiles ?? {}).map((name): [string, Pick] => [name, Pick.profile(name, offer, pick.effort, pick.speed)!]);
    switch (move) {
      case "next":
      case "prev":
      case "model": {
        return [...profiles, ...all];
      }
      case "up":
      case "down":
      case "effort": {
        return EFFORTS.map((effort) => [effort, { ...pick, effort }]);
      }
      case "speed": {
        return speeds.map((speed) => [speed, { ...pick, speed }]);
      }
    }
  }

  export function move(pick: Pick, move: Move, offer: Offer, to?: string): Pick | null {
    const list = Pick.options(pick, move, offer);
    const n    = list.length;
    const at   = list.findIndex(([, p]) => Pick.label(p) === Pick.label(pick) && p.profile === pick.profile);
    const d    = move === "prev" || move === "down" ? -1 : 1;
    const ends = move === "up" || move === "down";
    const next = ends ? Math.max(0, Math.min(n - 1, at + d)) : (at + d + n) % n;
    const like = list.filter(([part]) => part.toLowerCase().includes(String(to).toLowerCase()));
    const hit  = to === undefined ? list[next] : list.find(([part]) => part === to) ?? (like.length === 1 ? like[0] : undefined);
    return hit === undefined ? null : hit[1];
  }

  export function label(pick: Pick): string {
    return [pick.vendor, pick.model, pick.effort, pick.speed].join(":");
  }

  // as a call takes it: the model by its id
  export function ask(pick: Pick): Pick {
    const model = Pick.model(pick.vendor, pick.model);
    return { ...pick, model: model?.id ?? pick.model };
  }

  // a pick as a call took it (Pick.ask), by its model's label again
  export function named(run: Pick): Pick {
    const model = MODELS[run.vendor].find((m) => m.id === run.model);
    return { ...run, model: model?.label ?? run.model };
  }

  // what a call (as it takes its pick) runs on: its pick, then each
  // fallback not on a model before it, as a call takes it: picks only,
  // never the call's prompt or images (a Run event, which names them,
  // may go to another process)
  export function falls(run: Pick, falls: Fall[]): Pick[] {
    const own = { vendor: run.vendor, model: run.model, effort: run.effort, speed: run.speed };
    const list = falls.map((f) => {
      const on = Pick.on(own, f.vendor, f.model);
      return Pick.ask({ ...on, effort: f.effort ?? on.effort, speed: f.speed ?? on.speed });
    });
    return [own, ...list].filter((p, k, all) => all.findIndex((q) => q.vendor === p.vendor && q.model === p.model) === k);
  }

  // a profile as picked: its first model, at the effort and speed given
  // unless it names its own (a speed the model lacks: its fastest below);
  // null: none of that name
  export function profile(name: string, offer: Offer, effort: string, speed: string): Pick | null {
    const first = Object.hasOwn(offer.profiles ?? {}, name) ? offer.profiles![name][0] : undefined;
    if (first === undefined) {
      return null;
    }
    const on = Pick.on({ vendor: first.vendor, model: first.model.label, effort, speed }, first.vendor, first.model);
    return { ...on, effort: first.effort ?? effort, speed: first.speed ?? on.speed, profile: name };
  }

  // as the chat runs it (a profile's: as the config has it now); null: none
  export function read(x: any, offer: Offer): Pick | null {
    if (x.profile !== undefined) {
      return typeof x.profile === "string" && EFFORTS.includes(x.effort) ? Pick.profile(x.profile, offer, x.effort, String(x.speed)) : null;
    }
    const model = offer.vendors.includes(x.vendor) && offer.models.includes(x.model) ? Pick.model(x.vendor, x.model) : undefined;
    if (model === undefined || !EFFORTS.includes(x.effort) || !model.speeds.includes(x.speed)) {
      return null;
    }
    return { vendor: x.vendor, model: x.model, effort: x.effort, speed: x.speed };
  }

  // the pick saved (the chat's log keeps it: Memory.ts) if offered, else
  // def (Config checks it is offered)
  export function load(saved: object | null, offer: Offer, def: Pick): Pick {
    return Pick.read(saved ?? def, offer) ?? def;
  }

}
