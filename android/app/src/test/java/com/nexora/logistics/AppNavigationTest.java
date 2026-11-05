package com.nexora.logistics;
import org.junit.Test;
import static org.junit.Assert.*;
public class AppNavigationTest {
    private final String origin = "https://nexora.example/";
    @Test public void bridgeOnlyAcceptsTheDriverPage() {
        assertTrue(AppNavigation.isDriverPage("https://nexora.example/driver.html",origin));
        assertTrue(AppNavigation.isDriverPage("https://nexora.example/driver?view=jobs",origin));
        for(String bad:new String[]{"https://evil.example/driver","https://nexora.example/customer.html","https://nexora.example/driver-register.html","https://nexora.example/driver/other"})
            assertFalse(AppNavigation.isDriverPage(bad,origin));
    }
    @Test public void keepsOnlyTrustedHttpsOriginInsideApp() {
        assertTrue(AppNavigation.isAppUrl("https://nexora.example/customer.html", origin));
        assertTrue(AppNavigation.isAppUrl("https://nexora.example:443/driver.html", origin));
        for (String bad : new String[]{"http://nexora.example/", "https://nexora.example.evil.test/",
                "https://nexora.example@evil.test/", "https://evil.test@nexora.example/",
                "file:///android_asset/index.html", "javascript:alert(1)", "https://nexora.example:8443/", null})
            assertFalse(String.valueOf(bad), AppNavigation.isAppUrl(bad, origin));
    }
}
