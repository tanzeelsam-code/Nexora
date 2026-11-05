package com.nexora.logistics;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.GeolocationPermissions;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import org.json.JSONObject;
import java.util.Collections;

public class MainActivity extends Activity {
    private WebView webView;
    private LinearLayout connectionError;
    private String lastAppUrl = BuildConfig.APP_URL;
    private GeolocationPermissions.Callback locationCallback;
    private String locationOrigin;
    private static final int LOCATION_REQUEST = 101;
    private boolean resumed;

    @SuppressLint("SetJavaScriptEnabled")
    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        FrameLayout layout = new FrameLayout(this);
        layout.setBackgroundColor(Color.rgb(246, 247, 242));
        layout.setOnApplyWindowInsetsListener((view, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets safe = insets.getInsets(WindowInsets.Type.systemBars()
                        | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                view.setPadding(safe.left, safe.top, safe.right, safe.bottom);
            } else {
                view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                        insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            }
            return insets;
        });
        webView = new WebView(this);
        webView.setBackgroundColor(Color.rgb(246, 247, 242));
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setGeolocationEnabled(true);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setSupportMultipleWindows(false);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false);
        if (Build.VERSION.SDK_INT >= 26) settings.setSafeBrowsingEnabled(true);
        webView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (AppNavigation.isAppUrl(url, BuildConfig.APP_URL)) {
                    if (request.isForMainFrame()) lastAppUrl = url;
                    return false;
                }
                if (!request.isForMainFrame()) return false;
                String scheme = request.getUrl().getScheme();
                if ("https".equals(scheme) || "mailto".equals(scheme) || "tel".equals(scheme)) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); }
                    catch (android.content.ActivityNotFoundException missing) {
                        android.widget.Toast.makeText(MainActivity.this,
                                getString(R.string.link_unavailable), android.widget.Toast.LENGTH_LONG).show();
                    }
                }
                return true;
            }
            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) {
                if (AppNavigation.isAppUrl(url, BuildConfig.APP_URL)) {
                    lastAppUrl = url;
                }
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) showConnectionError();
            }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                if (request.isForMainFrame() && response.getStatusCode() >= 500) showConnectionError();
            }
            @Override public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
                ((android.view.ViewGroup)view.getParent()).removeView(view);
                view.destroy(); webView=null;
                showConnectionError();
                return true;
            }
            // Default SSL handling cancels: certificate errors are never bypassed.
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                if (!AppNavigation.isAppUrl(origin, BuildConfig.APP_URL)) {
                    callback.invoke(origin, false, false); return;
                }
                if (hasLocationPermission()) { callback.invoke(origin, true, false); return; }
                if (locationCallback != null) locationCallback.invoke(locationOrigin, false, false);
                locationCallback = callback;
                locationOrigin = origin;
                // Ask only after a location action, never at app startup.
                requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION,
                        Manifest.permission.ACCESS_COARSE_LOCATION}, LOCATION_REQUEST);
            }
        });
        if(WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            String origin=Uri.parse(BuildConfig.APP_URL).buildUpon().path("").build().toString();
            WebViewCompat.addWebMessageListener(webView,"NexoraNative",Collections.singleton(origin),
                (view,message,sourceOrigin,isMainFrame,reply)->{
                    if(!isMainFrame || !AppNavigation.isAppUrl(sourceOrigin.toString(),BuildConfig.APP_URL)
                        || !AppNavigation.isDriverPage(view.getUrl(),BuildConfig.APP_URL)) return;
                    JSONObject response=new JSONObject();
                    try {
                        JSONObject command=new JSONObject(message.getData());
                        response.put("id",command.optInt("id"));
                        switch(command.optString("command")) {
                            case "start":
                                if(!resumed || !hasLocationPermission()) throw new IllegalStateException("Open the driver screen and allow location before starting background updates.");
                                if(!DriverShiftService.running) {
                                    String token=command.getString("token");
                                    if(token.length()>4096 || token.isEmpty()) throw new IllegalArgumentException("Sign in again.");
                                    Intent shift=new Intent(this,DriverShiftService.class).putExtra("access_token",token);
                                    if(Build.VERSION.SDK_INT>=26) startForegroundService(shift); else startService(shift);
                                }
                                if(Build.VERSION.SDK_INT>=33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED)
                                    requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS},102);
                                response.put("starting",true);
                                break;
                            case "stop": stopService(new Intent(this,DriverShiftService.class)); break;
                            case "status": break;
                            default: throw new IllegalArgumentException("Unsupported driver action.");
                        }
                        response.put("running",DriverShiftService.running).put("message",DriverShiftService.state);
                    } catch(Exception problem) {
                        try { response.put("error","Background updates could not start. Open Nexora, allow location, and try again."); } catch(Exception ignored) { }
                    }
                    reply.postMessage(response.toString());
                });
        }
        layout.addView(webView, new FrameLayout.LayoutParams(-1, -1));
        connectionError = new LinearLayout(this);
        connectionError.setOrientation(LinearLayout.VERTICAL);
        connectionError.setGravity(android.view.Gravity.CENTER);
        connectionError.setPadding(32, 32, 32, 32);
        connectionError.setBackgroundColor(Color.rgb(246, 247, 242));
        TextView message = new TextView(this);
        message.setText(R.string.connection_unavailable);
        message.setTextColor(Color.rgb(33, 50, 42));
        message.setTextSize(18);
        Button retry = new Button(this);
        retry.setText(R.string.retry);
        retry.setOnClickListener(view -> {
            if(webView==null) { getIntent().putExtra("open_driver",AppNavigation.isDriverPage(lastAppUrl,BuildConfig.APP_URL));recreate();return; }
            connectionError.setVisibility(View.GONE);
            webView.setVisibility(View.VISIBLE);
            webView.loadUrl(lastAppUrl);
        });
        connectionError.addView(message);
        connectionError.addView(retry);
        connectionError.setVisibility(View.GONE);
        layout.addView(connectionError, new FrameLayout.LayoutParams(-1, -1));
        setContentView(layout);
        if (Build.VERSION.SDK_INT >= 33) getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::navigateBack);
        if (savedInstanceState == null || webView.restoreState(savedInstanceState) == null)
            webView.loadUrl(getIntent().getBooleanExtra("open_driver",false) ? BuildConfig.APP_URL+"driver.html" : BuildConfig.APP_URL);
    }
    private boolean hasLocationPermission() {
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
                || checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }
    private void showConnectionError() {
        if(webView!=null) webView.setVisibility(View.GONE);
        connectionError.setVisibility(View.VISIBLE);
    }
    @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        if (code == LOCATION_REQUEST && locationCallback != null) {
            locationCallback.invoke(locationOrigin, hasLocationPermission(), false);
            locationCallback = null;
        }
    }
    @Override protected void onSaveInstanceState(Bundle state) {
        if(webView!=null) webView.saveState(state);
        super.onSaveInstanceState(state);
    }
    private void navigateBack() {
        if (connectionError.getVisibility() == View.VISIBLE) {
            connectionError.setVisibility(View.GONE);
            if(webView!=null) webView.setVisibility(View.VISIBLE);
        }
        if (webView!=null && webView.canGoBack()) webView.goBack(); else finish();
    }
    @Override protected void onResume() { super.onResume(); resumed=true; }
    @Override protected void onPause() { resumed=false; super.onPause(); }
    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent); setIntent(intent);
        if(intent.getBooleanExtra("open_driver",false) && webView!=null) webView.loadUrl(BuildConfig.APP_URL+"driver.html");
    }
    // API 33+ uses the native predictive-back callback registered above.
    @SuppressLint("GestureBackNavigation")
    @Override public void onBackPressed() { navigateBack(); }
    @Override protected void onDestroy() {
        if (locationCallback != null) locationCallback.invoke(locationOrigin, false, false);
        if (webView != null) webView.destroy();
        super.onDestroy();
    }
}
