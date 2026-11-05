package com.nexora.logistics;
import java.net.URI;
/** Only an exact HTTPS origin match stays inside the app. */
final class AppNavigation {
    static boolean isDriverPage(String candidate,String appUrl) {
        if(!isAppUrl(candidate,appUrl)) return false;
        try { String path=new java.net.URI(candidate).getPath(); return "/driver".equals(path) || "/driver.html".equals(path); }
        catch(Exception malformed) { return false; }
    }
    static boolean isAppUrl(String value, String appUrl) {
        try {
            URI url = new URI(value), app = new URI(appUrl);
            return "https".equalsIgnoreCase(url.getScheme()) && url.getUserInfo() == null
                    && app.getHost().equalsIgnoreCase(url.getHost())
                    && (url.getPort()==-1?443:url.getPort()) == (app.getPort()==-1?443:app.getPort());
        } catch (Exception invalid) { return false; }
    }
    private AppNavigation() {}
}
