package com.rokelapdf.app;

import android.os.Bundle;
import android.webkit.WebSettings;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    /**
     * Android scales all web text by the system font size (up to 200%), but toolbars and tool tiles have fixed widths.
     * Large text still grows, up to this cap, so labels stay readable without running into each other.
     */
    private static final int MAX_TEXT_ZOOM = 130;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Local plugins must be registered before the bridge starts.
        registerPlugin(IncomingFilePlugin.class);
        registerPlugin(SaveFilePlugin.class);
        super.onCreate(savedInstanceState);
        // A font size change recreates the activity (fontScale is not in configChanges), so this runs again then.
        WebSettings settings = getBridge().getWebView().getSettings();
        int system = Math.round(getResources().getConfiguration().fontScale * 100);
        settings.setTextZoom(Math.min(system, MAX_TEXT_ZOOM));
    }
}
