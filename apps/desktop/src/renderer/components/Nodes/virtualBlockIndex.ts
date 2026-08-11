export interface VirtualRange {
  start: number
  end: number
  totalHeight: number
}

/** Fenwick-backed height index for O(log n) offset/index lookups. */
export class VirtualBlockIndex {
  private heights: number[] = []
  private tree: number[] = [0]
  private readonly estimatedHeight: number

  constructor(estimatedHeight = 96) {
    this.estimatedHeight = Math.max(1, Math.ceil(estimatedHeight))
  }

  resize(count: number): void {
    if (count === this.heights.length) return
    const next = Array.from({ length: count }, (_, index) => this.heights[index] ?? this.estimatedHeight)
    this.heights = next
    this.tree = Array.from({ length: count + 1 }, () => 0)
    next.forEach((height, index) => this.add(index + 1, height))
  }

  setHeight(index: number, height: number): boolean {
    if (index < 0 || index >= this.heights.length) return false
    const normalized = Math.max(32, Math.ceil(height))
    const delta = normalized - this.heights[index]
    if (!delta) return false
    this.heights[index] = normalized
    this.add(index + 1, delta)
    return true
  }

  heightAt(index: number): number {
    return this.heights[index] ?? this.estimatedHeight
  }

  offsetOf(index: number): number {
    const clamped = Math.max(0, Math.min(index, this.heights.length))
    return this.sum(clamped)
  }

  totalHeight(): number {
    return this.offsetOf(this.heights.length)
  }

  indexAt(offset: number): number {
    if (!this.heights.length) return 0
    const target = Math.max(0, Math.min(offset, this.totalHeight() - 1))
    let index = 0
    let accumulated = 0
    let bit = 1
    while ((bit << 1) <= this.heights.length) bit <<= 1
    for (; bit; bit >>= 1) {
      const candidate = index + bit
      if (candidate <= this.heights.length && accumulated + this.tree[candidate] <= target) {
        index = candidate
        accumulated += this.tree[candidate]
      }
    }
    return Math.min(index, this.heights.length - 1)
  }

  visibleRange(scrollTop: number, viewportHeight: number, overscan = 3): VirtualRange {
    const count = this.heights.length
    if (!count) return { start: 0, end: 0, totalHeight: 0 }
    const first = Math.max(0, this.indexAt(scrollTop) - overscan)
    const last = Math.min(count, this.indexAt(scrollTop + Math.max(1, viewportHeight)) + 1 + overscan)
    return { start: first, end: Math.max(first, last), totalHeight: this.totalHeight() }
  }

  private add(index: number, delta: number): void {
    for (let cursor = index; cursor < this.tree.length; cursor += cursor & -cursor) this.tree[cursor] += delta
  }

  private sum(count: number): number {
    let result = 0
    for (let cursor = count; cursor > 0; cursor -= cursor & -cursor) result += this.tree[cursor]
    return result
  }
}

export function virtualBlockIndexSelfCheck(): boolean {
  const index = new VirtualBlockIndex(10)
  index.resize(1000)
  index.setHeight(400, 200)
  return index.indexAt(index.offsetOf(400) + 1) === 400 && index.visibleRange(0, 100).end < 20
}
