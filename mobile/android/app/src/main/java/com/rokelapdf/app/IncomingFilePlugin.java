package com.rokelapdf.app;

import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Base64;

import androidx.core.content.IntentCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;

/**
 * Receives a PDF that another app sent with "Open with" (ACTION_VIEW) or "Share" (ACTION_SEND).
 * Only content:// URIs granted by the sender are read; the bytes are handed to the web layer once.
 */
@CapacitorPlugin(name = "IncomingFile")
public class IncomingFilePlugin extends Plugin {
    /** Larger files would strain low-end phones once base64-encoded across the bridge. */
    private static final int MAX_BYTES = 50 * 1024 * 1024;
    private Uri pending;

    @Override
    public void load() {
        capture(getActivity().getIntent());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (capture(intent)) notifyListeners("fileReceived", new JSObject());
    }

    private boolean capture(Intent intent) {
        if (intent == null) return false;
        Uri uri = null;
        if (Intent.ACTION_VIEW.equals(intent.getAction())) uri = intent.getData();
        else if (Intent.ACTION_SEND.equals(intent.getAction())) uri = IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri.class);
        if (uri == null || !"content".equals(uri.getScheme())) return false;
        pending = uri;
        // Do not deliver the same file again if the activity is recreated (rotation, theme change).
        getActivity().setIntent(new Intent(Intent.ACTION_MAIN));
        return true;
    }

    @PluginMethod
    public void take(PluginCall call) {
        final Uri uri = pending;
        pending = null;
        if (uri == null) {
            call.resolve(new JSObject());
            return;
        }
        getBridge().execute(() -> {
            try {
                JSObject ret = new JSObject();
                ret.put("name", displayName(uri));
                ret.put("type", getContext().getContentResolver().getType(uri));
                ret.put("data", Base64.encodeToString(read(uri), Base64.NO_WRAP));
                call.resolve(ret);
            } catch (TooLarge e) {
                call.reject("This file is larger than 50 MB.");
            } catch (Exception e) {
                call.reject("This file could not be read.");
            }
        });
    }

    private static class TooLarge extends Exception {}

    private byte[] read(Uri uri) throws Exception {
        try (InputStream in = getContext().getContentResolver().openInputStream(uri); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            if (in == null) throw new IllegalStateException("no stream");
            byte[] buf = new byte[64 * 1024];
            int n, total = 0;
            while ((n = in.read(buf)) != -1) {
                total += n;
                if (total > MAX_BYTES) throw new TooLarge();
                out.write(buf, 0, n);
            }
            return out.toByteArray();
        }
    }

    private String displayName(Uri uri) {
        try (Cursor c = getContext().getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                String name = c.getString(0);
                if (name != null && !name.isEmpty()) return name;
            }
        } catch (Exception ignored) {
            // Some providers refuse metadata queries; fall back to a generic name.
        }
        return "document.pdf";
    }
}
