# Indexed-access proofs

Source: [`src/guards/index-bounds.ts`](../../../src/guards/index-bounds.ts)

`provenIndex(node, checker)` establishes presence for an in-range integer index into a dense array literal, or a zero-based, unit-step loop bounded by the length of a standard typed array. It compares TypeScript symbols for the counter and receiver. The loop body must preserve both bindings and contain no calls, constructors or suspension points. Ordinary arrays can contain holes; their length alone is insufficient to establish presence.
