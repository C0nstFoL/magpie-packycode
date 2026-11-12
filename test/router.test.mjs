import { test } from "node:test"
import assert from "node:assert/strict"

import { parsePricing } from "../src/pricing.mjs"
import { orderFor, explain, MIN_SUCCESS } from "../src/router.mjs"
import { PRICING } from "./fake.mjs"

const pricing = parsePricing(PRICING)
const key = (k, groups, live) => ({ key: k, groups, groupMode: groups.length > 1 ? "multi" : "single", live })
const down = () => ({ keyed: new Map(), whole: new Map() })

const keys = [key("sk-pricey", ["pricey"]), key("sk-cheap", ["cheap"]), key("sk-mid", ["mid"])]

test("the cheapest group goes first, the dearest last", () => {
  const c = orderFor({ model: "claude-x", keys, pricing, perf: null, down: down() })
  assert.deepEqual(
    c.map((x) => x.group),
    ["cheap", "mid", "pricey"],
  )
  assert.equal(c[0].multiplier, 0.5)
})

test("a group PackyAPI saw failing is left out while a healthy one is left", () => {
  const perf = new Map([
    ["cheap", { success: 40, ttft: 100 }],
    ["mid", { success: 99, ttft: 900 }],
  ])
  const c = orderFor({ model: "claude-x", keys, pricing, perf, down: down() })
  assert.deepEqual(
    c.map((x) => x.group),
    ["mid", "pricey", "cheap"],
  )
  assert.ok(MIN_SUCCESS > 40)
  // checking off: the cheap one leads again
  const off = orderFor({ model: "claude-x", keys, pricing, perf, down: down(), opts: { check_performance: false } })
  assert.equal(off[0].group, "cheap")
})

test("a restricted pool is only used when the user says so", () => {
  const cc = [key("sk-cc", ["cc"])]
  const c = orderFor({ model: "claude-x", keys: cc, pricing, perf: null, down: down() })
  assert.equal(c.length, 1)
  assert.equal(c[0].skip, "restricted")
  assert.match(explain("claude-x", c, pricing, cc), /forbids third-party/)

  const yes = orderFor({ model: "claude-x", keys: cc, pricing, perf: null, down: down(), opts: { include_restricted: true } })
  assert.equal(yes[0].group, "cc")
})

test("a multi-group key is priced at its dearest group, after a pinned one", () => {
  const mixed = [key("sk-multi", ["mid", "pricey"]), key("sk-mid", ["mid"])]
  const c = orderFor({ model: "claude-x", keys: mixed, pricing, perf: null, down: down() })
  assert.equal(c[0].multiplier, 1)
  assert.equal(c[0].multi, false)
  assert.equal(c[1].multiplier, 2) // pricey may answer it
  assert.equal(c[1].multi, true)
})

test("a key that does not list the model now is not asked", () => {
  const live = [key("sk-cheap", ["cheap"], new Map()), key("sk-mid", ["mid"], new Map([["claude-x", []]]))]
  const c = orderFor({ model: "claude-x", keys: live, pricing, perf: null, down: down() })
  assert.deepEqual(
    c.map((x) => x.key.key),
    ["sk-mid"],
  )
})

test("a cooled key goes after the open ones but is still offered", () => {
  const d = down()
  d.keyed.set("sk-cheap|claude-x", Date.now() + 60_000)
  const c = orderFor({ model: "claude-x", keys, pricing, perf: null, down: d })
  assert.equal(c[0].group, "mid")
  assert.equal(c.at(-1).group, "cheap")
})

test("a delisted pool still competes at the price it had", () => {
  const p = parsePricing(PRICING)
  p.knownGroups = { "cc-sale": 0.8 }
  p.models.get("claude-x").groups = ["cheap", "mid", "cc-sale"]
  const keys = [key("sk-cheap", ["cheap"]), key("sk-sale", ["cc-sale"]), key("sk-mid", ["mid"])]
  const c = orderFor({ model: "claude-x", keys, pricing: p, perf: null, down: down(), opts: { claude_group_order: false } })
  assert.deepEqual(
    c.map((x) => x.group),
    ["cheap", "cc-sale", "mid"],
  )
})

test("prefer_speed puts the healthier group first", () => {
  const perf = new Map([
    ["cheap", { success: 95, ttft: 5000 }],
    ["mid", { success: 99.9, ttft: 400 }],
  ])
  const c = orderFor({ model: "claude-x", keys, pricing, perf, down: down(), opts: { prefer_speed: true, claude_group_order: false } })
  assert.equal(c[0].group, "mid")
})

test("a model no group of ours serves says so", () => {
  const none = [key("sk-cheap", ["cheap"])]
  const c = orderFor({ model: "gpt-x", keys: none, pricing, perf: null, down: down() })
  assert.equal(c.length, 0)
  assert.match(explain("gpt-x", c, pricing, none), /no PackyAPI key serves/)
})

test("claude and codex follow the fixed order from the switches, ahead of price", () => {
  const model = "claude-x"
  const groups = ["cc-sale", "cc-expensive", "cheap"]
  const pr = { models: new Map([[model, { id: model, groups }]]), groupRatio: new Map([["cc-sale", 0.8], ["cc-expensive", 2.8], ["cheap", 0.3]]) }
  const ks = groups.map((g) => key("sk-" + g, [g]))
  const run = (opts, d = down()) => orderFor({ model, keys: ks, pricing: pr, perf: null, down: d, opts: { include_restricted: true, ...opts } }).map((x) => x.group)
  assert.deepEqual(run({}), ["cc-sale", "cc-expensive", "cheap"])
  assert.deepEqual(run({ claude_sale_first: false }), ["cc-expensive", "cc-sale", "cheap"])
  assert.equal(run({ claude_group_order: false })[0], "cheap")
  const d = down()
  d.whole.set("sk-cc-sale", Date.now() + 60_000)
  assert.equal(run({}, d)[0], "cc-expensive")

  const gm = "gpt-6.1-sol"
  const gg = ["codex-sale", "codex", "azure-officially"]
  const gp = { models: new Map([[gm, { id: gm, groups: gg }]]), groupRatio: new Map([["codex-sale", 0.3], ["codex", 0.5], ["azure-officially", 5]]) }
  const gk = gg.map((g) => key("sk-" + g, [g]))
  const gr = (opts) => orderFor({ model: gm, keys: gk, pricing: gp, perf: null, down: down(), opts }).filter((x) => !x.skip).map((x) => x.group)
  assert.deepEqual(gr({ include_restricted: true }), ["codex", "codex-sale", "azure-officially"])
  assert.equal(gr({ include_restricted: true, codex_group_auto: true })[0], "codex-sale")
  // the fixed order never overrides the restricted-pool switch
  assert.deepEqual(gr({}), ["azure-officially"])
  // The unified switch wins over stale legacy settings for both families.
  assert.deepEqual(run({ fixed_group_order: true, claude_sale_first: false, claude_group_order: false }), ["cc-sale", "cc-expensive", "cheap"])
  assert.equal(run({ fixed_group_order: false })[0], "cheap")
  assert.equal(gr({ fixed_group_order: true, codex_group_auto: true, include_restricted: true })[0], "codex")
  assert.equal(gr({ fixed_group_order: false, include_restricted: true })[0], "codex-sale")
  assert.deepEqual(gr({ fixed_group_order: true }), ["azure-officially"])
})
