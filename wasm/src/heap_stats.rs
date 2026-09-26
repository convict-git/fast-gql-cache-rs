//! Byte counters for the WASM heap, read by the memory probe
//! (`docs/probes/cache-memory-probe.mjs`).
//!
//! JavaScript can see the size of the linear memory (`WebAssembly.Memory`), but not
//! how much of it is in use: the allocator keeps freed blocks, and linear memory
//! never shrinks. These counters wrap the system allocator so the probe can report
//! bytes in use, the peak since the last reset, and the total ever allocated (the
//! allocation volume of an operation is the difference of two readings).
//!
//! The cost is three relaxed atomic operations per allocation. On
//! `wasm32-unknown-unknown` without the `atomics` target feature they compile to
//! plain loads and stores.

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

use wasm_bindgen::prelude::*;

struct CountingAllocator;

static IN_USE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
static ALLOCATED_TOTAL: AtomicU64 = AtomicU64::new(0);

fn record_growth(bytes: usize) {
    let in_use = IN_USE.fetch_add(bytes, Ordering::Relaxed) + bytes;
    PEAK.fetch_max(in_use, Ordering::Relaxed);
    ALLOCATED_TOTAL.fetch_add(bytes as u64, Ordering::Relaxed);
}

fn record_shrink(bytes: usize) {
    IN_USE.fetch_sub(bytes, Ordering::Relaxed);
}

// SAFETY: every method forwards to `System` with the caller's arguments unchanged,
// so `System`'s guarantees carry over. The counters are updated only after `System`
// reports success, and never affect the pointers returned.
unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        // SAFETY: the caller upholds `GlobalAlloc::alloc`'s contract for `layout`.
        let ptr = unsafe { System.alloc(layout) };
        if !ptr.is_null() {
            record_growth(layout.size());
        }
        ptr
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        // SAFETY: the caller upholds `GlobalAlloc::alloc_zeroed`'s contract.
        let ptr = unsafe { System.alloc_zeroed(layout) };
        if !ptr.is_null() {
            record_growth(layout.size());
        }
        ptr
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        // SAFETY: the caller guarantees `ptr` was allocated by this allocator with
        // `layout`, and this allocator hands out only `System` allocations.
        unsafe { System.dealloc(ptr, layout) };
        record_shrink(layout.size());
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        // SAFETY: the caller upholds `GlobalAlloc::realloc`'s contract, and `ptr`
        // came from `System` (see `dealloc`).
        let new_ptr = unsafe { System.realloc(ptr, layout, new_size) };
        if !new_ptr.is_null() {
            let old_size = layout.size();
            if new_size >= old_size {
                record_growth(new_size - old_size);
            } else {
                record_shrink(old_size - new_size);
            }
        }
        new_ptr
    }
}

#[global_allocator]
static GLOBAL: CountingAllocator = CountingAllocator;

/// Bytes currently allocated on the WASM heap.
#[wasm_bindgen]
pub fn wasm_heap_in_use() -> f64 {
    IN_USE.load(Ordering::Relaxed) as f64
}

/// The highest `wasm_heap_in_use` since the last `wasm_heap_reset_peak`.
#[wasm_bindgen]
pub fn wasm_heap_peak() -> f64 {
    PEAK.load(Ordering::Relaxed) as f64
}

/// Bytes allocated since the module started, never decreasing.
#[wasm_bindgen]
pub fn wasm_heap_allocated_total() -> f64 {
    ALLOCATED_TOTAL.load(Ordering::Relaxed) as f64
}

/// Starts a new peak window at the current in-use size.
#[wasm_bindgen]
pub fn wasm_heap_reset_peak() {
    PEAK.store(IN_USE.load(Ordering::Relaxed), Ordering::Relaxed);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_allocation_growth_and_release() {
        let before_in_use = wasm_heap_in_use();
        let before_total = wasm_heap_allocated_total();

        let mut buffer: Vec<u8> = Vec::with_capacity(4096);
        assert!(wasm_heap_in_use() >= before_in_use + 4096.0);
        assert!(wasm_heap_allocated_total() >= before_total + 4096.0);

        buffer.reserve_exact(8192);
        assert!(wasm_heap_allocated_total() >= before_total + 8192.0);
        assert!(wasm_heap_peak() >= wasm_heap_in_use());

        drop(buffer);
        assert!(wasm_heap_allocated_total() >= before_total + 8192.0);
    }
}
