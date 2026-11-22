package com.schedulingpilot.app;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Fingerprint clock-in on the shared tablet, through the separate Pilot Clock
 * app (com.schedpilot.fingerprint), which drives the USB fingerprint reader.
 *
 * Pilot Clock keeps the fingerprints, encrypted, on the tablet. Each person is
 * enrolled there with their 4-digit clock-in code; a matching scan hands that
 * code back here, and the shared clock-in screen carries on exactly as if it
 * had been typed. No fingerprint data ever reaches this app or the server.
 * See src/lib/native/fingerprint.ts and docs/mobile/fingerprint-reader.md.
 */
@CapacitorPlugin(name = "Fingerprint")
public class FingerprintPlugin extends Plugin {

    static final String ACTION_IDENTIFY = "com.schedpilot.fingerprint.IDENTIFY";
    static final String PILOT_CLOCK_PACKAGE = "com.schedpilot.fingerprint";

    private Intent identifyIntent() {
        return new Intent(ACTION_IDENTIFY).setPackage(PILOT_CLOCK_PACKAGE);
    }

    /** Whether Pilot Clock is installed on this device. */
    @PluginMethod
    public void isAvailable(PluginCall call) {
        PackageManager pm = getContext().getPackageManager();
        boolean available = !pm.queryIntentActivities(identifyIntent(), 0).isEmpty();
        JSObject result = new JSObject();
        result.put("available", available);
        call.resolve(result);
    }

    /**
     * Opens Pilot Clock's scan window. Resolves with { ok: true, code, name }
     * on a match, or { ok: false, error } when the scan was cancelled or failed.
     */
    @PluginMethod
    public void identify(PluginCall call) {
        Intent intent = identifyIntent();
        String title = call.getString("title");
        if (title != null) intent.putExtra("title", title);
        try {
            startActivityForResult(call, intent, "identifyResult");
        } catch (ActivityNotFoundException e) {
            call.reject("Pilot Clock is not installed", "NOT_INSTALLED");
        }
    }

    @ActivityCallback
    private void identifyResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        JSObject out = new JSObject();
        if (result.getResultCode() == Activity.RESULT_OK && data != null && data.getStringExtra("employee_id") != null) {
            out.put("ok", true);
            out.put("code", data.getStringExtra("employee_id"));
            out.put("name", data.getStringExtra("employee_name"));
        } else {
            out.put("ok", false);
            out.put("error", data != null && data.getStringExtra("error") != null ? data.getStringExtra("error") : "Cancelled");
        }
        call.resolve(out);
    }
}
