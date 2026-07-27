import { expect, it } from "bun:test"

import type { Dependency, Provision, Scope } from "ripple-di"
import { createRuntime, provide } from "ripple-di"

interface Box {
  readonly value: number
}

interface SlotNode {
  readonly kind: "slot"
  readonly defaultValue: number
}

interface ComputedNode {
  readonly kind: "computed"
  readonly dependencies: readonly number[]
  readonly operation: ModelOperation
}

type ModelNode = SlotNode | ComputedNode
type ModelOperation = "sum" | "weighted" | "conditional"

interface ReferenceBinding {
  readonly id: string
  readonly value: number
}

interface ReferenceScope {
  readonly parent?: ReferenceScope
  readonly overrides: ReadonlyMap<number, ReferenceBinding>
}

interface ReferenceValue {
  readonly value: number
  readonly bindings: ReadonlyMap<number, string>
}

interface ScopePair {
  readonly actual: Scope
  readonly reference: ReferenceScope
  readonly parent?: ScopePair
}

// Forty cases give broad deterministic coverage while keeping the test fast.
const MODEL_SEED_START = 1
const MODEL_SEED_COUNT = 40

// Each generated graph stays small enough to diagnose directly from its seed.
const MIN_SLOT_COUNT = 3
const MAX_SLOT_COUNT = 5
const MIN_COMPUTED_COUNT = 5
const MAX_COMPUTED_COUNT = 8
const MIN_COMPUTED_DEPENDENCIES = 1
const MAX_COMPUTED_DEPENDENCIES = 3

// Override values use a disjoint range so failures visibly identify their source.
const MIN_DEFAULT_VALUE = 1
const MAX_DEFAULT_VALUE = 20
const MIN_OVERRIDE_VALUE = 21
const MAX_OVERRIDE_VALUE = 80
const MAX_OVERRIDES_PER_SCOPE = 3

// Arithmetic stays bounded while still producing different transitive results.
const WEIGHTED_OPERATION_FACTOR = 31
const MODEL_VALUE_MODULUS = 100_000
// Conditional nodes choose a branch from the parity of dependency #1.
const CONDITIONAL_BRANCH_MODULUS = 2

// Numerical Recipes LCG parameters provide a simple reproducible 32-bit stream.
const LCG_MULTIPLIER = 1_664_525
const LCG_INCREMENT = 1_013_904_223

const MODEL_OPERATIONS: readonly ModelOperation[] = [
  "sum",
  "weighted",
  "conditional",
]

const ROOT_SCOPE_INDEX = 0
const LEVEL_ONE_SCOPE_INDEX = 1
const LEVEL_TWO_SCOPE_INDEX = 2
const SIBLING_SCOPE_INDEX = 3

it(`matches values and identity sharing for ${MODEL_SEED_COUNT} deterministic seeds`, async () => {
  const seedLimit = MODEL_SEED_START + MODEL_SEED_COUNT
  for (let seed = MODEL_SEED_START; seed < seedLimit; seed += 1) {
    await verifySeed(seed)
  }
})

async function verifySeed(seed: number) {
  const random = createRandom(seed)
  const runtime = createRuntime({ name: `model-${seed}` })
  const slotCount = random.integer(MIN_SLOT_COUNT, MAX_SLOT_COUNT)
  const computedCount = random.integer(MIN_COMPUTED_COUNT, MAX_COMPUTED_COUNT)
  const model: ModelNode[] = []
  const dependencies: Dependency<Box>[] = []

  for (let index = 0; index < slotCount; index += 1) {
    const defaultValue = random.integer(MIN_DEFAULT_VALUE, MAX_DEFAULT_VALUE)
    model.push({ kind: "slot", defaultValue })
    dependencies.push(
      runtime.defineSlot({
        name: `slot-${index}`,
        default: () => ({ value: defaultValue }),
      }),
    )
  }

  for (let index = slotCount; index < slotCount + computedCount; index += 1) {
    const isInitialComputed = index === slotCount
    const dependencyCount = isInitialComputed
      ? MAX_COMPUTED_DEPENDENCIES
      : random.integer(
          MIN_COMPUTED_DEPENDENCIES,
          Math.min(MAX_COMPUTED_DEPENDENCIES, index),
        )
    const node: ComputedNode = {
      kind: "computed",
      dependencies: random.distinctIntegers(dependencyCount, 0, index - 1),
      operation: isInitialComputed
        ? "conditional"
        : valueAt(
            MODEL_OPERATIONS,
            random.integer(0, MODEL_OPERATIONS.length - 1),
            "model operation",
          ),
    }
    model.push(node)
    dependencies.push(
      runtime.defineComputed(
        () => ({
          value: evaluateNode(
            node,
            (dependencyIndex) =>
              valueAt(dependencies, dependencyIndex, "computed dependency")()
                .value,
          ),
        }),
        { name: `computed-${index}` },
      ),
    )
  }

  const rootReference: ReferenceScope = {
    overrides: new Map(),
  }
  const root: ScopePair = {
    actual: runtime.createScope(),
    reference: rootReference,
  }
  const level1 = createRandomScope(
    seed,
    LEVEL_ONE_SCOPE_INDEX,
    root,
    slotCount,
    dependencies,
    random,
  )
  const level2 = createRandomScope(
    seed,
    LEVEL_TWO_SCOPE_INDEX,
    level1,
    slotCount,
    dependencies,
    random,
  )
  const sibling = createRandomScope(
    seed,
    SIBLING_SCOPE_INDEX,
    root,
    slotCount,
    dependencies,
    random,
  )
  const scopes = [root, level1, level2, sibling]

  const probes = scopes.flatMap((scope, scopeIndex) =>
    model.map((_node, nodeIndex) => ({ scope, scopeIndex, nodeIndex })),
  )
  random.shuffle(probes)

  const actualValues = new Map<string, Box>()
  const references = new Map<string, ReferenceValue>()
  for (const probe of probes) {
    const key = `${probe.scopeIndex}:${probe.nodeIndex}`
    const reference = resolveReference(
      model,
      probe.nodeIndex,
      probe.scope.reference,
      new Map(),
    )
    const actual = probe.scope.actual.resolve(
      valueAt(dependencies, probe.nodeIndex, "probe dependency"),
    )
    actualValues.set(key, actual)
    references.set(key, reference)
    if (actual.value !== reference.value) {
      throw new Error(
        `seed=${seed} scope=${probe.scopeIndex} node=${probe.nodeIndex}: ` +
          `${actual.value} !== ${reference.value}`,
      )
    }
  }

  for (
    let scopeIndex = LEVEL_ONE_SCOPE_INDEX;
    scopeIndex < scopes.length;
    scopeIndex += 1
  ) {
    const scope = valueAt(scopes, scopeIndex, "scope under comparison")
    if (!scope.parent) {
      throw new Error(`seed=${seed}: child scope has no parent`)
    }
    const parentIndex = scopes.indexOf(scope.parent)
    for (let nodeIndex = slotCount; nodeIndex < model.length; nodeIndex += 1) {
      const childKey = `${scopeIndex}:${nodeIndex}`
      const parentKey = `${parentIndex}:${nodeIndex}`
      const sameBindings = mapsEqual(
        mapValue(references, childKey, "child reference").bindings,
        mapValue(references, parentKey, "parent reference").bindings,
      )
      const sameIdentity =
        mapValue(actualValues, childKey, "child value") ===
        mapValue(actualValues, parentKey, "parent value")
      if (sameBindings !== sameIdentity) {
        throw new Error(
          `seed=${seed} scope=${scopeIndex} node=${nodeIndex}: ` +
            `sameBindings=${sameBindings}, sameIdentity=${sameIdentity}`,
        )
      }
    }
  }

  await level2.actual.close()
  await level1.actual.close()
  await sibling.actual.close()
  await root.actual.close()
  await runtime.dispose()
  expect(scopes).toHaveLength(SIBLING_SCOPE_INDEX + 1)
}

function createRandomScope(
  seed: number,
  scopeIndex: number,
  parent: ScopePair,
  slotCount: number,
  dependencies: readonly Dependency<Box>[],
  random: ReturnType<typeof createRandom>,
): ScopePair {
  const overrideCount = random.integer(
    0,
    Math.min(MAX_OVERRIDES_PER_SCOPE, slotCount),
  )
  const slots = random.distinctIntegers(overrideCount, 0, slotCount - 1)
  const overrides = new Map<number, ReferenceBinding>()
  const provisions: Provision[] = []

  for (const slot of slots) {
    const value = random.integer(MIN_OVERRIDE_VALUE, MAX_OVERRIDE_VALUE)
    overrides.set(slot, {
      id: `${seed}:${scopeIndex}:${slot}`,
      value,
    })
    provisions.push(
      provide(valueAt(dependencies, slot, "overridden slot"), { value }),
    )
  }

  return {
    actual: parent.actual.createScope(provisions),
    reference: { parent: parent.reference, overrides },
    parent,
  }
}

function resolveReference(
  model: readonly ModelNode[],
  nodeIndex: number,
  scope: ReferenceScope,
  cache: Map<number, ReferenceValue>,
): ReferenceValue {
  const cached = cache.get(nodeIndex)
  if (cached) {
    return cached
  }
  const node = valueAt(model, nodeIndex, "reference model node")

  let result: ReferenceValue
  if (node.kind === "slot") {
    const binding = findBinding(scope, nodeIndex) ?? {
      id: `${ROOT_SCOPE_INDEX}:${nodeIndex}`,
      value: node.defaultValue,
    }
    result = {
      value: binding.value,
      bindings: new Map([[nodeIndex, binding.id]]),
    }
  } else {
    const readValues = new Map<number, ReferenceValue>()
    const value = evaluateNode(node, (dependencyIndex) => {
      const dependency = resolveReference(model, dependencyIndex, scope, cache)
      readValues.set(dependencyIndex, dependency)
      return dependency.value
    })
    const bindings = new Map<number, string>()
    for (const dependency of readValues.values()) {
      for (const [slot, binding] of dependency.bindings) {
        bindings.set(slot, binding)
      }
    }
    result = { value, bindings }
  }

  cache.set(nodeIndex, result)
  return result
}

function evaluateNode(
  node: ComputedNode,
  read: (dependencyIndex: number) => number,
): number {
  const index1 = valueAt(node.dependencies, 0, "computed dependency #1")
  const index2 = node.dependencies[1] ?? index1
  const index3 = node.dependencies[2] ?? index1
  const value1 = read(index1)
  if (node.operation === "sum") {
    return (value1 + read(index2)) % MODEL_VALUE_MODULUS
  }
  if (node.operation === "weighted") {
    return (
      (value1 * WEIGHTED_OPERATION_FACTOR + read(index2)) % MODEL_VALUE_MODULUS
    )
  }
  return value1 % CONDITIONAL_BRANCH_MODULUS === 0 ? read(index2) : read(index3)
}

function findBinding(
  scope: ReferenceScope,
  slot: number,
): ReferenceBinding | undefined {
  for (
    let cursor: ReferenceScope | undefined = scope;
    cursor;
    cursor = cursor.parent
  ) {
    const binding = cursor.overrides.get(slot)
    if (binding) {
      return binding
    }
  }
}

function mapsEqual(
  left: ReadonlyMap<number, string>,
  right: ReadonlyMap<number, string>,
): boolean {
  if (left.size !== right.size) {
    return false
  }
  for (const [key, value] of left) {
    if (right.get(key) !== value) {
      return false
    }
  }
  return true
}

function createRandom(seed: number) {
  // `>>> 0` keeps every state transition in the unsigned 32-bit domain.
  let state = seed >>> 0
  const next = () => {
    state = (Math.imul(state, LCG_MULTIPLIER) + LCG_INCREMENT) >>> 0
    return state
  }

  return {
    integer(minimum: number, maximum: number) {
      return minimum + (next() % (maximum - minimum + 1))
    },
    distinctIntegers(count: number, minimum: number, maximum: number) {
      const values = new Set<number>()
      while (values.size < count) {
        values.add(minimum + (next() % (maximum - minimum + 1)))
      }
      return [...values]
    },
    shuffle<T>(values: T[]) {
      for (let index = values.length - 1; index > 0; index -= 1) {
        const swap = next() % (index + 1)
        const temporary = valueAt(values, index, "shuffle value")
        values[index] = valueAt(values, swap, "shuffle swap value")
        values[swap] = temporary
      }
    },
  }
}

function valueAt<T>(values: readonly T[], index: number, label: string): T {
  const value = values[index]
  if (value === undefined) {
    throw new Error(`Missing ${label} at index ${index}.`)
  }
  return value
}

function mapValue<K, V>(values: ReadonlyMap<K, V>, key: K, label: string): V {
  const value = values.get(key)
  if (value === undefined) {
    throw new Error(`Missing ${label}.`)
  }
  return value
}
