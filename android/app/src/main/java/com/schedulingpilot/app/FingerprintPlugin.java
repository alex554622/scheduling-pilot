package com.schedulingpilot.app;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Fingerprint clock-in on the shared tablet, through the separate Pilot Clock
 * app (com.schedpilot.fingerprint), which carries the USB reader's driver.
 *
 * Pilot Clock keeps the fingerprints, encrypted, on the tablet. An admin
 * registers each person from the Shared clock-in page (enroll), keyed by their
 * user ID and holding their 4-digit clock-in code. On the shared clock-in
 * screen a matching scan hands that code back (identify), and the screen
 * carries on exactly as if it had been typed. Pilot Clock only answers this
 * app. No fingerprint data ever reaches this app or the server.
 * See src/lib/native/fingerprint.ts and docs/mobile/fingerprint-reader.md.
 */
@CapacitorPlugin(name = "Fingerprint")
public class FingerprintPlugin extends Plugin {

    static final String PILOT_CLOCK_PACKAGE = "com.schedpilot.fingerprint";
    static final String ACTION_IDENTIFY = "com.schedpilot.fingerprint.IDENTIFY";
    static final String ACTION_ENROLL = "com.schedpilot.fingerprint.ENROLL";
    static final String ACTION_API = "com.schedpilot.fingerprint.API";

    private static Intent pilotClock(String action) {
        return new Intent(action).setPackage(PILOT_CLOCK_PACKAGE);
    }

    private boolean installed() {
        PackageManager pm = getContext().getPackageManager();
        return !pm.queryIntentActivities(pilotClock(ACTION_IDENTIFY), 0).isEmpty();
    }

    /** Whether Pilot Clock is installed on this device. */
    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject result = new JSObject();
        result.put("available", installed());
        call.resolve(result);
    }

    /**
     * { installed, readerAttached, enrolled: userId[] }. When Pilot Clock is
     * missing, or is an older build without the status call, resolves with
     * what is known rather than failing.
     */
    @PluginMethod
    public void status(PluginCall call) {
        if (!installed()) {
            JSObject out = new JSObject();
            out.put("installed", false);
            out.put("readerAttached", false);
            out.put("enrolled", new JSArray());
            call.resolve(out);
            return;
        }
        launch(call, pilotClock(ACTION_API).putExtra("op", "status"), "statusResult");
    }

    @ActivityCallback
    private void statusResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        JSObject out = new JSObject();
        out.put("installed", true);
        JSArray enrolled = new JSArray();
        boolean ok = result.getResultCode() == Activity.RESULT_OK && data != null;
        if (ok) {
            String[] ids = data.getStringArrayExtra("enrolled");
            if (ids != null) for (String id : ids) enrolled.put(id);
        }
        out.put("readerAttached", ok && data.getBooleanExtra("reader_attached", false));
        out.put("enrolled", enrolled);
        if (!ok) out.put("error", errorOf(data, "Pilot Clock did not answer. Update it to the latest version."));
        call.resolve(out);
    }

    /** Opens Pilot Clock's register window for { userId, name, code }. Resolves { ok, error? }. */
    @PluginMethod
    public void enroll(PluginCall call) {
        String userId = call.getString("userId");
        String code = call.getString("code");
        if (userId == null || code == null) {
            call.reject("userId and code are required");
            return;
        }
        Intent intent = pilotClock(ACTION_ENROLL)
                .putExtra("user_id", userId)
                .putExtra("name", call.getString("name", ""))
                .putExtra("code", code);
        launch(call, intent, "okResult");
    }

    /** Deletes { userId }'s fingerprint from the tablet. Resolves { ok, error? }. */
    @PluginMethod
    public void remove(PluginCall call) {
        String userId = call.getString("userId");
        if (userId == null) {
            call.reject("userId is required");
            return;
        }
        launch(call, pilotClock(ACTION_API).putExtra("op", "remove").putExtra("user_id", userId), "okResult");
    }

    /** After an admin issues a new code: { userId, code }. Resolves { ok, error? }. */
    @PluginMethod
    public void updateCode(PluginCall call) {
        String userId = call.getString("userId");
        String code = call.getString("code");
        if (userId == null || code == null) {
            call.reject("userId and code are required");
            return;
        }
        Intent intent = pilotClock(ACTION_API)
                .putExtra("op", "update_code")
                .putExtra("user_id", userId)
                .putExtra("code", code);
        launch(call, intent, "okResult");
    }

    @ActivityCallback
    private void okResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        JSObject out = new JSObject();
        boolean ok = result.getResultCode() == Activity.RESULT_OK;
        out.put("ok", ok);
        if (!ok) out.put("error", errorOf(result.getData(), "Cancelled"));
        call.resolve(out);
    }

    /**
     * Opens Pilot Clock's scan window. Resolves with { ok: true, code, name }
     * on a match, or { ok: false, error } when the scan was cancelled or failed.
     */
    @PluginMethod
    public void identify(PluginCall call) {
        Intent intent = pilotClock(ACTION_IDENTIFY);
        String title = call.getString("title");
        if (title != null) intent.putExtra("title", title);
        launch(call, intent, "identifyResult");
    }

    @ActivityCallback
    private void identifyResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        JSObject out = new JSObject();
        // clock_code from current Pilot Clock; older builds enrolled people under the code as their ID.
        String code = data == null ? null
                : data.getStringExtra("clock_code") != null ? data.getStringExtra("clock_code")
                : data.getStringExtra("employee_id");
        if (result.getResultCode() == Activity.RESULT_OK && code != null) {
            out.put("ok", true);
            out.put("code", code);
            out.put("name", data.getStringExtra("employee_name"));
        } else {
            out.put("ok", false);
            out.put("error", errorOf(data, "Cancelled"));
        }
        call.resolve(out);
    }

    private void launch(PluginCall call, Intent intent, String callback) {
        try {
            startActivityForResult(call, intent, callback);
        } catch (ActivityNotFoundException e) {
            call.reject("Pilot Clock is not installed, or needs updating", "NOT_INSTALLED");
        }
    }

    private static String errorOf(Intent data, String fallback) {
        String e = data == null ? null : data.getStringExtra("error");
        return e != null ? e : fallback;
    }
}
