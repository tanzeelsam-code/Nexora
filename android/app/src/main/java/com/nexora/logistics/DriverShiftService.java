package com.nexora.logistics;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.SystemClock;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/** An explicitly started shift, not an always-on or boot-started location collector. */
public final class DriverShiftService extends Service implements LocationListener {
    private static final int SHIFT_NOTIFICATION=41, JOB_NOTIFICATION=42;
    private static final String SHIFT_CHANNEL="driver_shift", JOB_CHANNEL="driver_jobs";
    static volatile boolean running=false;
    static volatile String state="Background updates are off.";
    private volatile boolean stopped=false;
    private volatile Location latest;
    private String token,refreshToken;
    private long sentFix=-1;
    private final Set<String> seenJobs=new HashSet<>();
    private ScheduledExecutorService work;
    private LocationManager locations;
    private PowerManager.WakeLock wakeLock;

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public void onCreate() {
        super.onCreate();
        NotificationManager manager=getSystemService(NotificationManager.class);
        if(Build.VERSION.SDK_INT>=26) {
            manager.createNotificationChannel(new NotificationChannel(SHIFT_CHANNEL,getString(R.string.shift_channel),NotificationManager.IMPORTANCE_LOW));
            manager.createNotificationChannel(new NotificationChannel(JOB_CHANNEL,getString(R.string.jobs_channel),NotificationManager.IMPORTANCE_HIGH));
        }
        work=Executors.newSingleThreadScheduledExecutor();
    }

    @SuppressLint("MissingPermission") // Both coarse/fine permission are checked immediately below.
    @Override public int onStartCommand(Intent intent,int flags,int startId) {
        if(intent==null || running || !hasLocation()) { if(!running) stopSelf(); return START_NOT_STICKY; }
        String bootstrap=intent.getStringExtra("access_token");
        if(bootstrap==null || bootstrap.length()>4096) { stopSelf(); return START_NOT_STICKY; }
        state=getString(R.string.shift_starting);
        try {
            if(Build.VERSION.SDK_INT>=29) startForeground(SHIFT_NOTIFICATION,notification(SHIFT_CHANNEL,state),ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
            else startForeground(SHIFT_NOTIFICATION,notification(SHIFT_CHANNEL,state));
        } catch(RuntimeException unavailable) {
            state=getString(R.string.shift_start_failed); stopSelf(); return START_NOT_STICKY;
        }
        running=true;
        locations=getSystemService(LocationManager.class);
        try {
            for(String provider:new String[]{LocationManager.GPS_PROVIDER,LocationManager.NETWORK_PROVIDER}) {
                if(locations.getAllProviders().contains(provider) && locations.isProviderEnabled(provider)) locations.requestLocationUpdates(provider,10000,0,this);
            }
        } catch(SecurityException denied) { updateState(getString(R.string.shift_permission_lost));stopSelf();return START_NOT_STICKY; }
        wakeLock=getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,"Nexora:driverShift");
        wakeLock.setReferenceCounted(false);
        wakeLock.acquire(2*60*1000L);
        work.execute(()->{
            try {
                JSONObject credentials=request("/driver/mobile-session","POST",new JSONObject(),bootstrap);
                token=credentials.getString("token"); refreshToken=credentials.getString("refresh_token");
                if(stopped) { revoke(); return; }
                work.scheduleWithFixedDelay(this::tick,0,10,TimeUnit.SECONDS);
            } catch(Exception unavailable) { updateState(getString(R.string.shift_start_failed)); stopSelf(); }
        });
        return START_NOT_STICKY;
    }

    private boolean hasLocation() {
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)==PackageManager.PERMISSION_GRANTED
            || checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION)==PackageManager.PERMISSION_GRANTED;
    }

    @SuppressLint("MissingPermission") // User notification grant is checked before posting a job alert.
    private void tick() {
        if(stopped) return;
        try {
            if(!hasLocation()) { updateState(getString(R.string.shift_permission_lost)); stopSelf(); return; }
            wakeLock.acquire(2*60*1000L);
            JSONObject jobs=authorized("/driver/jobs/current","GET",null);
            if(stopped) return;
            JSONObject driver=jobs.getJSONObject("driver");
            if(!driver.optBoolean("is_online") || "suspended".equals(driver.optString("status"))) { stopSelf(); return; }
            for(String kind:new String[]{"trips","deliveries"}) {
                JSONArray items=jobs.getJSONArray(kind);
                for(int i=0;i<items.length();i++) {
                    JSONObject job=items.getJSONObject(i);
                    String key=kind+":"+job.getString("id")+":"+job.getString("status");
                    if(seenJobs.add(key) && (Build.VERSION.SDK_INT<33 || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)==PackageManager.PERMISSION_GRANTED))
                        getSystemService(NotificationManager.class).notify(JOB_NOTIFICATION,notification(JOB_CHANNEL,getString(R.string.shift_job_updated)));
                }
            }
            Location fix=latest;
            if(fix!=null && DriverShiftPolicy.isFresh(SystemClock.elapsedRealtimeNanos(),fix.getElapsedRealtimeNanos()) && sentFix!=fix.getElapsedRealtimeNanos()) {
                // Each GPS fix is submitted once. Old fixes and failed mutations are not queued/replayed.
                sentFix=fix.getElapsedRealtimeNanos();
                JSONObject body=new JSONObject().put("lat",fix.getLatitude()).put("lng",fix.getLongitude())
                    .put("accuracy_m",Math.min(32000,Math.round(fix.getAccuracy())));
                authorized("/driver/location","POST",body);
                updateState(getString(R.string.shift_connected));
            } else if(fix==null || !DriverShiftPolicy.isFresh(SystemClock.elapsedRealtimeNanos(),fix.getElapsedRealtimeNanos())) {
                updateState(getString(R.string.shift_waiting_gps));
            }
        } catch(ApiException failure) {
            if(failure.status==401 || failure.status==403) { updateState(getString(R.string.shift_signin)); stopSelf(); }
            else updateState(getString(R.string.shift_connection_lost));
        } catch(Exception failure) { updateState(getString(R.string.shift_connection_lost)); }
    }

    private JSONObject authorized(String path,String method,JSONObject body) throws Exception {
        try { return request(path,method,body,token); }
        catch(ApiException denied) {
            if(denied.status!=401) throw denied;
            // Only an explicit 401 can trigger token renewal and the original request.
            JSONObject fresh=request("/auth/refresh","POST",new JSONObject().put("refresh_token",refreshToken),null);
            token=fresh.getString("token"); refreshToken=fresh.getString("refresh_token");
            return request(path,method,body,token);
        }
    }

    private JSONObject request(String path,String method,JSONObject body,String accessToken) throws Exception {
        URL url=new URL(new URL(BuildConfig.APP_URL),"/api/v1"+path);
        HttpURLConnection connection=(HttpURLConnection)url.openConnection();
        try {
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(8000); connection.setReadTimeout(8000);
            connection.setRequestMethod(method);
            connection.setRequestProperty("Accept","application/json");
            if(accessToken!=null) connection.setRequestProperty("Authorization","Bearer "+accessToken);
            if(body!=null) {
                connection.setDoOutput(true); connection.setRequestProperty("Content-Type","application/json");
                byte[] bytes=body.toString().getBytes(StandardCharsets.UTF_8);
                connection.setFixedLengthStreamingMode(bytes.length);
                try(java.io.OutputStream output=connection.getOutputStream()) { output.write(bytes); }
            }
            int status=connection.getResponseCode();
            if(status<200 || status>=300) throw new ApiException(status);
            try(InputStream input=connection.getInputStream(); ByteArrayOutputStream output=new ByteArrayOutputStream()) {
                byte[] buffer=new byte[4096]; int length;
                while((length=input.read(buffer))!=-1) {
                    output.write(buffer,0,length);
                    if(output.size()>1024*1024) throw new java.io.IOException("Response too large");
                }
                return new JSONObject(output.toString(StandardCharsets.UTF_8.name()));
            }
        } finally { connection.disconnect(); }
    }

    private Notification notification(String channel,String text) {
        Intent open=new Intent(this,MainActivity.class).putExtra("open_driver",true)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP|Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pending=PendingIntent.getActivity(this,0,open,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder builder=Build.VERSION.SDK_INT>=26?new Notification.Builder(this,channel):new Notification.Builder(this);
        return builder.setSmallIcon(R.drawable.ic_shift).setContentTitle(getString(R.string.app_name)).setContentText(text)
            .setContentIntent(pending).setVisibility(Notification.VISIBILITY_PRIVATE)
            .setOngoing(SHIFT_CHANNEL.equals(channel)).setOnlyAlertOnce(SHIFT_CHANNEL.equals(channel)).build();
    }

    private void updateState(String text) {
        if(stopped) return;
        state=text;
        if(Build.VERSION.SDK_INT<33 || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)==PackageManager.PERMISSION_GRANTED)
            getSystemService(NotificationManager.class).notify(SHIFT_NOTIFICATION,notification(SHIFT_CHANNEL,text));
    }

    @Override public void onLocationChanged(Location location) { latest=new Location(location); }
    @Override public void onProviderDisabled(String provider) { latest=null; }
    @Override public void onProviderEnabled(String provider) { }
    @Override public void onStatusChanged(String provider,int status,Bundle extras) { }

    private void revoke() {
        try { if(token!=null) request("/auth/logout","POST",new JSONObject().put("refresh_token",refreshToken),token); }
        catch(Exception ignored) { /* No retries or credential persistence; server sessions still expire. */ }
        token=null; refreshToken=null;
    }

    @Override public void onDestroy() {
        stopped=true; running=false;
        state="Background updates stopped. "+state;
        if(locations!=null) try { locations.removeUpdates(this); } catch(SecurityException ignored) { }
        latest=null;
        if(wakeLock!=null && wakeLock.isHeld()) wakeLock.release();
        if(work!=null) { work.execute(this::revoke); work.shutdown(); }
        getSystemService(NotificationManager.class).cancel(JOB_NOTIFICATION);
        stopForeground(true);
        super.onDestroy();
    }
    private static final class ApiException extends Exception {
        final int status;
        ApiException(int status) { super("HTTP "+status); this.status=status; }
    }
}
