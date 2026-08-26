package com.upio.executor;

import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * TermuxPlugin — cầu nối để launcher APK tự động cài Harness Executor qua Termux
 * (RUN_COMMAND service): tự tạo environment + tự chạy lệnh + tự connect,
 * không cần người dùng gõ gì trong Termux.
 */
@CapacitorPlugin(name = "TermuxRun")
public class TermuxPlugin extends Plugin {

    public static final String TERMUX_PKG = "com.termux";
    public static final String RUN_COMMAND_SERVICE = TERMUX_PKG + ".app.RunCommandService";
    public static final String RUN_COMMAND_PATH = "com.termux.RUN_COMMAND_PATH";
    public static final String RUN_COMMAND_ARGS = "com.termux.RUN_COMMAND_ARGUMENTS";
    public static final String RUN_COMMAND_BACKGROUND = "com.termux.RUN_COMMAND_BACKGROUND";

    @PluginMethod
    public void isTermuxAvailable(PluginCall call) {
        JSObject r = new JSObject();
        boolean installed = true;
        try {
            getContext().getPackageManager().getPackageInfo(TERMUX_PKG, 0);
        } catch (PackageManager.NameNotFoundException e) {
            installed = false;
        }
        boolean service = getContext().getPackageManager().resolveService(
                new Intent().setClassName(TERMUX_PKG, RUN_COMMAND_SERVICE),
                PackageManager.GET_RESOLVED_FILTER) != null;
        r.put("installed", installed);
        r.put("service", service);
        r.put("available", installed && service);
        call.resolve(r);
    }

    /** Chạy 1 lệnh shell nền trong Termux (mặc định: bash -c '<cmd>') */
    @PluginMethod
    public void run(PluginCall call) {
        String cmd = call.getString("command", "");
        if (cmd.isEmpty()) { call.reject("thiếu command"); return; }
        Intent intent = new Intent();
        intent.setClassName(TERMUX_PKG, RUN_COMMAND_SERVICE);
        intent.putExtra(RUN_COMMAND_PATH, "/data/data/com.termux/files/usr/bin/bash");
        intent.putExtra(RUN_COMMAND_ARGS, new String[]{"-c", cmd});
        intent.putExtra(RUN_COMMAND_BACKGROUND, true);
        try {
            getContext().startService(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("Termux từ chối: " + e.getMessage());
        }
    }

    /** Mở Play Store / trình cài đặt Shizuku khi cần */
    @PluginMethod
    public void openUrl(PluginCall call) {
        String url = call.getString("url", "");
        if (!url.isEmpty()) {
            getContext().startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        }
        call.resolve();
    }
}
