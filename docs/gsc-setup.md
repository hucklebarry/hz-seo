# Google Search Console Setup (OAuth)

This app uses Google OAuth to access Search Console metrics per shop.

## 1) Create Google OAuth Credentials
- Create or select a Google Cloud project.
- Enable the “Search Console API”.
- Configure the OAuth consent screen.
- Create OAuth Client ID (Web application).

## 2) Set Redirect URI
Use the same value you’ll place in `GOOGLE_REDIRECT_URI`. Example:

```
https://<your-app-url>/app/gsc/callback
```

## 3) Environment Variables
Add the following to your `.env` or hosting environment:

```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=https://<your-app-url>/app/gsc/callback
```

## 4) Connect in App
Open **Settings → Google Search Console** and click **Connect**.
