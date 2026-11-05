package com.nexora.logistics;
import org.junit.Test;
import static org.junit.Assert.*;
public class DriverShiftPolicyTest {
    @Test public void oldFutureAndMissingFixesCannotBeUploadedAsLive() {
        assertTrue(DriverShiftPolicy.isFresh(31_000_000_000L,1_000_000_000L));
        assertFalse(DriverShiftPolicy.isFresh(31_000_000_001L,1_000_000_000L));
        assertFalse(DriverShiftPolicy.isFresh(10,11));
        assertFalse(DriverShiftPolicy.isFresh(10,0));
    }
}
