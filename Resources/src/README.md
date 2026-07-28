# Icon source

`farnsworth-icon.svg` is the vector source of truth for `../farnsworth-icon.icns`.
It matches the inline `.titlebar__logo` SVG in `index.html` — keep the two in sync.

## Regenerate the .icns (must preserve alpha)

```sh
cd Resources/src
rm -rf icon.iconset && mkdir icon.iconset
for spec in "16 icon_16x16" "32 icon_16x16@2x" "32 icon_32x32" "64 icon_32x32@2x" \
            "128 icon_128x128" "256 icon_128x128@2x" "256 icon_256x256" \
            "512 icon_256x256@2x" "512 icon_512x512" "1024 icon_512x512@2x"; do
  SZ=${spec%% *}; NM=${spec##* }
  rsvg-convert -w $SZ -h $SZ -b none farnsworth-icon.svg -o "icon.iconset/$NM.png"
done
iconutil -c icns icon.iconset -o ../farnsworth-icon.icns
sips -g hasAlpha ../farnsworth-icon.icns   # MUST print "hasAlpha: yes"
```

**The `-b none` flag on rsvg-convert is load-bearing.** Without it (or with a
`-b white` default from some toolchains) every size is written as RGB with no
alpha channel, and macOS composites the rounded corners onto white — the app
shows an icon with white corner wedges instead of transparent ones. That is
exactly the bug fixed here: the previous .icns reported `hasAlpha: no` for 8 of
its 10 sizes. Always verify with `sips -g hasAlpha` before committing.
