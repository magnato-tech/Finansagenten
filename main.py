from market_scanner import scan_market

print("Finansagenten starter")
print("=" * 40)

df = scan_market()

if df.empty:
    print("Ingen aksjer funnet med pris mellom MA50 og MA150.")
else:
    print(f"Fant {len(df)} aksje(r) med pris mellom MA50 og MA150:\n")
    print(df.to_string(index=False))
