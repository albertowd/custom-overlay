/** ResizeObserver that only reports when a test calls `resize`. */
export class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  readonly targets = new Set<Element>();

  constructor(readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }

  observe(target: Element): void {
    this.targets.add(target);
  }

  unobserve(target: Element): void {
    this.targets.delete(target);
  }

  disconnect(): void {
    this.targets.clear();
  }

  /** Report a new content size for every observed element. */
  resize(width: number, height: number): void {
    const entries = [...this.targets].map(
      (target) => ({ target, contentRect: { width, height } }) as unknown as ResizeObserverEntry,
    );
    this.callback(entries, this as unknown as ResizeObserver);
  }

  static resizeAll(width: number, height: number): void {
    for (const observer of FakeResizeObserver.instances) observer.resize(width, height);
  }
}
