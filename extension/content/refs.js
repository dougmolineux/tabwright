// Element ref registry for this frame (SPEC 6.2). Refs are allocated from a tab-wide counter that the
// background script passes in, so "e12" is unique across all frames of a tab.
(() => {
  const CB = (globalThis.Tabwright = globalThis.Tabwright || {});
  if (CB.refsLoaded) return;
  CB.refsLoaded = true;

  /** ref -> { weak: WeakRef<Element>, page: string } */
  const byRef = new Map();
  /** Element -> ref, so re-snapshots keep the same ref for the same element. */
  const byEl = new WeakMap();

  const pageKey = () => location.origin + location.pathname + location.search;

  /** Allocation context for one request: { next: number, created: string[] }. */
  CB.newAllocator = (nextRef) => ({ next: Number.isInteger(nextRef) && nextRef > 0 ? nextRef : 1, created: [] });

  CB.refFor = (el, alloc) => {
    const existing = byEl.get(el);
    if (existing && byRef.get(existing)?.weak.deref() === el && byRef.get(existing).page === pageKey()) return existing;
    const ref = `e${alloc.next++}`;
    byRef.set(ref, { weak: new WeakRef(el), page: pageKey() });
    byEl.set(el, ref);
    alloc.created.push(ref);
    return ref;
  };

  /** Resolves a ref to a live element, or throws E_STALE_REF. */
  CB.resolveRef = (ref) => {
    const entry = byRef.get(ref);
    const el = entry?.weak.deref();
    if (!entry || !el || !el.isConnected || entry.page !== pageKey()) {
      if (entry) byRef.delete(ref);
      CB.fail("E_STALE_REF", `Ref ${ref} is no longer valid (the page changed). Take a new snapshot.`);
    }
    return el;
  };

  CB.refCount = () => byRef.size;
})();
