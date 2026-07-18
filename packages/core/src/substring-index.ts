/**
 * Compact Aho–Corasick automaton: find every occurrence of a fixed pattern set
 * inside many texts in time linear in text length (plus matches), replacing the
 * planner's former pairwise `a.includes(b)` scans — O(n²) over a full-book
 * substrate of ~90k units, minutes on-device — with a single indexed pass.
 */
export class SubstringIndex {
  private next: Map<string, number>[] = [new Map()]
  private fail: number[] = [0]
  /** Pattern ids (indexes into `patterns`) whose match ends at this node. */
  private out: number[][] = [[]]
  readonly patterns: string[]

  constructor(patterns: string[]) {
    this.patterns = patterns
    patterns.forEach((pattern, id) => {
      let node = 0
      // UTF-16 code-unit iteration throughout, so match positions/lengths agree
      // with String#length / indexOf semantics (surrogate pairs = two units).
      for (let i = 0; i < pattern.length; i += 1) {
        const ch = pattern[i]
        let child = this.next[node].get(ch)
        if (child == null) {
          child = this.next.length
          this.next[node].set(ch, child)
          this.next.push(new Map())
          this.fail.push(0)
          this.out.push([])
        }
        node = child
      }
      this.out[node].push(id)
    })

    // BFS to wire failure links (classic construction).
    const queue: number[] = []
    for (const child of this.next[0].values()) {
      queue.push(child)
    }
    for (let head = 0; head < queue.length; head += 1) {
      const node = queue[head]
      for (const [ch, child] of this.next[node]) {
        queue.push(child)
        let f = this.fail[node]
        while (f > 0 && !this.next[f].has(ch)) {
          f = this.fail[f]
        }
        this.fail[child] = node === 0 ? 0 : (this.next[f].get(ch) ?? 0)
        // Merge output links so every match surfaces at its end node.
        if (this.out[this.fail[child]].length) {
          this.out[child] = this.out[child].concat(this.out[this.fail[child]])
        }
      }
    }
  }

  /**
   * All pattern occurrences in `text` as {patternId, end} (end = index AFTER
   * the match). Overlaps and repeats are all reported.
   */
  matches(text: string): {patternId: number; end: number}[] {
    const found: {patternId: number; end: number}[] = []
    let node = 0
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i]
      while (node > 0 && !this.next[node].has(ch)) {
        node = this.fail[node]
      }
      node = this.next[node].get(ch) ?? 0
      if (this.out[node].length) {
        for (const patternId of this.out[node]) {
          found.push({patternId, end: i + 1})
        }
      }
    }
    return found
  }

  /** The distinct pattern ids occurring anywhere in `text`. */
  matchedPatternIds(text: string): Set<number> {
    const ids = new Set<number>()
    for (const {patternId} of this.matches(text)) {
      ids.add(patternId)
    }
    return ids
  }
}
