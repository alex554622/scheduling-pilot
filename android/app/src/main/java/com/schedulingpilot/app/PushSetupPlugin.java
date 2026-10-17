package com.schedulingpilot.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Tells the web app whether this build can register for push.
 *
 * The push-notifications plugin calls FirebaseMessaging.getInstance() on
 * register(), which crashes the whole app when the build has no
 * google-services.json (Firebase is never initialised). The Google services
 * Gradle plugin turns that file into a "google_app_id" string resource, so
 * the resource being there is the answer. See src/lib/native/push.ts and
 * docs/mobile/push-notifications.md.
 */
@CapacitorPlugin(name = "PushSetup")
public class PushSetupPlugin extends Plugin {

    @PluginMethod
    public void isConfigured(PluginCall call) {
        int id = getContext().getResources().getIdentifier("google_app_id", "string", getContext().getPackageName());
        JSObject result = new JSObject();
        result.put("configured", id != 0);
        call.resolve(result);
    }
}
