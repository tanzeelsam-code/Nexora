package com.nexora.logistics;

final class DriverShiftPolicy {
    private DriverShiftPolicy() { }
    static boolean isFresh(long nowNanos,long fixNanos) {
        return fixNanos>0 && nowNanos>=fixNanos && nowNanos-fixNanos<=30_000_000_000L;
    }
}
