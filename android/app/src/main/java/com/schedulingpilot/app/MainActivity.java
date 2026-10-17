package com.schedulingpilot.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The app's own plugin (not an npm package), registered before the bridge starts.
        registerPlugin(PushSetupPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
