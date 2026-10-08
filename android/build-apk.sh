#!/usr/bin/env bash

# Sandi signing TIDAK ditulis di berkas ini. Diambil dari IVVI_KEYSTORE_PASS
# atau berkas lokal android/.keystore-pass (di-gitignore).
if [ -z "${IVVI_KEYSTORE_PASS:-}" ]; then
  if [ -f android/.keystore-pass ]; then
    IVVI_KEYSTORE_PASS=$(sed -n 1p android/.keystore-pass)
  else
    echo "!! set IVVI_KEYSTORE_PASS atau isi android/.keystore-pass"; exit 1
  fi
fi
# ============================================================
# ivvibill — build 4 APK (WebView wrapper) tanpa Gradle.
# Prasyarat: JDK 17, ANDROID_HOME berisi platform-tools +
# platforms;android-34 + build-tools;34.0.0.
#
# Pemakaian:  BASE_URL=https://domainanda.com ./build-apk.sh
# Hasil:      out/IvviPanel.apk, IvviAgen.apk, IvviTeknisi.apk,
#             IvviPelanggan.apk (sudah di-zipalign + signed)
# ============================================================
set -euo pipefail

ANDROID_HOME="${ANDROID_HOME:-/opt/android-sdk}"
BT="$ANDROID_HOME/build-tools/34.0.0"
AJ="$ANDROID_HOME/platforms/android-34/android.jar"
BASE_URL="${BASE_URL:-http://ivvinet.my.id}"
KEYSTORE="${KEYSTORE:-$(dirname "$0")/ivvibill.keystore}"

[ -f "$AJ" ] || { echo "android.jar tidak ada: $AJ"; exit 1; }
[ -x "$BT/aapt2" ] || { echo "build-tools tidak ada: $BT"; exit 1; }

# --- keystore (sekali saja) ---
if [ ! -f "$KEYSTORE" ]; then
  keytool -genkeypair -v -keystore "$KEYSTORE" -alias ivvibill \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass "$IVVI_KEYSTORE_PASS" -keypass "$IVVI_KEYSTORE_PASS" \
    -dname "CN=ivvibill, OU=ISP, O=ivvibill, C=ID" >/dev/null 2>&1
  echo "Keystore dibuat: $KEYSTORE"
fi

build_one() {
  local pkg="$1" appname="$2" urlpath="$3" outname="$4" color="$5"
  local work="build/$pkg"
  rm -rf "$work"; mkdir -p "$work/res/values" "$work/res/drawable" "$work/obj" "$work/apk"

  # --- manifest ---
  cat > "$work/AndroidManifest.xml" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="$pkg" android:versionCode="1" android:versionName="1.0">
  <uses-sdk android:minSdkVersion="26" android:targetSdkVersion="34" />
  <uses-permission android:name="android.permission.INTERNET" />
  <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
  <application android:label="$appname" android:icon="@mipmap/ic_launcher"
      android:usesCleartextTraffic="true" android:allowBackup="false"
      android:supportsRtl="true">
    <activity android:name=".MainActivity" android:exported="true"
        android:configChanges="orientation|screenSize|keyboardHidden"
        android:windowSoftInputMode="adjustResize">
      <intent-filter>
        <action android:name="android.intent.action.MAIN" />
        <category android:name="android.intent.category.LAUNCHER" />
      </intent-filter>
    </activity>
  </application>
</manifest>
EOF

  # --- resources: adaptive icon (vector) + warna ---
  mkdir -p "$work/res/mipmap-anydpi-v26"
  cat > "$work/res/mipmap-anydpi-v26/ic_launcher.xml" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
  <background android:drawable="@color/icbg"/>
  <foreground android:drawable="@drawable/icfg"/>
</adaptive-icon>
EOF
  cat > "$work/res/values/colors.xml" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<resources><color name="icbg">$color</color></resources>
EOF
  cat > "$work/res/drawable/icfg.xml" <<'EOF'
<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp" android:height="108dp"
    android:viewportWidth="108" android:viewportHeight="108">
  <!-- iV monogram sederhana -->
  <path android:fillColor="#FFFFFF"
      android:pathData="M40,32h8v44h-8z"/>
  <path android:fillColor="#FFFFFF"
      android:pathData="M54,32h9l7,26 7,-26h9l-12,44h-8z"/>
  <!-- gelombang sinyal -->
  <path android:strokeColor="#FFFFFF" android:strokeWidth="4" android:fillColor="#00000000"
      android:pathData="M36,80 q18,-14 36,0"/>
</vector>
EOF

  # --- java ---
  mkdir -p "$work/src/$(echo "$pkg" | tr . /)"
  cat > "$work/src/$(echo "$pkg" | tr . /)/MainActivity.java" <<EOF
package $pkg;

import android.app.Activity;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.*;
import java.util.Arrays;

public class MainActivity extends Activity {
    private WebView wv;
    private ValueCallback<Uri[]> filePathCallback;
    private static final int FILE_PICK = 101;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        wv = new WebView(this);
        setContentView(wv);

        WebSettings s = wv.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);

        wv.setWebViewClient(new WebViewClient());
        wv.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view,
                    ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (filePathCallback != null) filePathCallback.onReceiveValue(null);
                filePathCallback = cb;
                startActivityForResult(params.createIntent(), FILE_PICK);
                return true;
            }
        });
        wv.loadUrl("$BASE_URL$urlpath");
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_PICK && filePathCallback != null) {
            Uri[] results = null;
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                results = new Uri[] { data.getData() };
            }
            filePathCallback.onReceiveValue(results);
            filePathCallback = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onBackPressed() {
        if (wv != null && wv.canGoBack()) wv.goBack();
        else super.onBackPressed();
    }
}
EOF
  # Intent belum di-import di atas karena ditulis terpisah — tambahkan import:
  sed -i 's/^import java.util.Arrays;/import android.content.Intent;/' "$work/src/$(echo "$pkg" | tr . /)/MainActivity.java"

  echo "▸ Build $outname"
  "$BT/aapt2" compile --dir "$work/res" -o "$work/res.zip" >/dev/null
  "$BT/aapt2" link -o "$work/apk/base.apk" -I "$AJ" \
    --manifest "$work/AndroidManifest.xml" --auto-add-overlay "$work/res.zip" >/dev/null

  javac -source 1.8 -target 1.8 -nowarn -bootclasspath "$AJ" \
    -d "$work/obj" "$work/src/$(echo "$pkg" | tr . /)/MainActivity.java" 2>/dev/null

  "$BT/d8" --release --lib "$AJ" --output "$work/obj" "$work/obj/$(echo "$pkg" | tr . /)/MainActivity.class"

  (cd "$work/obj" && "$BT/zipalign" -f -p 4 base.apk unsigned.apk 2>/dev/null || cp ../apk/base.apk unsigned.apk)
  # masukkan classes.dex
  (cd "$work/obj" && cp ../apk/base.apk unsigned.apk && zip -q unsigned.apk classes.dex)
  "$BT/zipalign" -f -p 4 "$work/obj/unsigned.apk" "$work/obj/aligned.apk"

  "$BT/apksigner" sign --ks "$KEYSTORE" --ks-pass pass:ivvibill123 \
    --key-pass pass:ivvibill123 --out "out/$outname" "$work/obj/aligned.apk"
  echo "  ✓ out/$outname"
}

mkdir -p out
build_one "id.ivvibill.panel"    "ivvibill Panel"    "/panel/"    "IvviPanel.apk"    "#14532d"
build_one "id.ivvibill.agen"     "ivvibill Agen"     "/agen/"     "IvviAgen.apk"     "#7c2d12"
build_one "id.ivvibill.teknisi"  "ivvibill Teknisi"  "/teknisi/"  "IvviTeknisi.apk"  "#1e3a8a"
build_one "id.ivvibill.pelanggan" "ivvibill Pelanggan" "/pelanggan/" "IvviPelanggan.apk" "#4a1d96"

echo
echo "Selesai. APK ada di out/:"
ls -la out/
