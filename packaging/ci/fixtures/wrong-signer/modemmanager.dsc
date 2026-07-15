-----BEGIN PGP SIGNED MESSAGE-----
Hash: SHA512

Format: 3.0 (quilt)
Source: modemmanager
Binary: modemmanager, modemmanager-dev, modemmanager-doc, libmm-glib0, libmm-glib-dev, libmm-glib-doc, gir1.2-modemmanager-1.0
Architecture: linux-any all
Version: 1.24.0-1
Maintainer: DebianOnMobile Maintainers <debian-on-mobile-maintainers@alioth-lists.debian.net>
Uploaders: Arnaud Ferraris <aferraris@debian.org>, Guido Günther <agx@sigxcpu.org>, Henry-Nicolas Tourneur <debian@nilux.be>, Martin <debacle@debian.org>
Homepage: https://www.freedesktop.org/wiki/Software/ModemManager/
Standards-Version: 4.7.2
Vcs-Browser: https://salsa.debian.org/DebianOnMobile-team/modemmanager
Vcs-Git: https://salsa.debian.org/DebianOnMobile-team/modemmanager.git
Testsuite: autopkgtest
Testsuite-Triggers: @builddeps@, dpkg-dev, pkgconf
Build-Depends: debhelper-compat (= 13), debhelper (>= 13.11.6), dh-sequence-gir, bash-completion, gettext, libdbus-1-dev, libgirepository1.0-dev, libglib2.0-dev, libgudev-1.0-dev, libmbim-glib-dev (>= 1.32~), libpolkit-gobject-1-dev (>= 0.97), libqmi-glib-dev (>= 1.36~), libsystemd-dev (>= 209), meson, polkitd, python3-dbus, python3-gi, systemd-dev, valac (>= 0.22), xsltproc, gtk-doc-tools <!nodoc>, libglib2.0-doc <!nodoc>, dbus <!nocheck>
Package-List:
 gir1.2-modemmanager-1.0 deb introspection optional arch=linux-any
 libmm-glib-dev deb libdevel optional arch=linux-any
 libmm-glib-doc deb doc optional arch=all profile=!nodoc
 libmm-glib0 deb libs optional arch=linux-any
 modemmanager deb net optional arch=linux-any
 modemmanager-dev deb libdevel optional arch=linux-any
 modemmanager-doc deb doc optional arch=all profile=!nodoc
Checksums-Sha1:
 d0d6f2b3d5d003bb9825d5158bcee9cbd4853009 1361836 modemmanager_1.24.0.orig.tar.xz
 b675ec976905fe175947a8aafcc66ec99edd6dd5 36680 modemmanager_1.24.0-1.debian.tar.xz
Checksums-Sha256:
 63ded4c0f3936bb0db5ae35ef1dfd57c5d5b4dd8a5cdaa7fb2182255218c9168 1361836 modemmanager_1.24.0.orig.tar.xz
 7585e8cf6fb920e516372ed54d8f5c3d2faf1ffec920ec90fb550b9aaa11de12 36680 modemmanager_1.24.0-1.debian.tar.xz
Files:
 288cdf074430ef95268c9fe04873f047 1361836 modemmanager_1.24.0.orig.tar.xz
 97dce306035804a7bfb5e263febb1e98 36680 modemmanager_1.24.0-1.debian.tar.xz

-----BEGIN PGP SIGNATURE-----

iQIzBAEBCgAdFiEEY/bM35YinQkoayrDJb+GUkr8weMFAmf6CusACgkQJb+GUkr8
weM7YRAAuDc4hy8TDZN/nqGAvk5so+r5v/ixxlQ3pvJG6cih08LkzTOrjgSS+tg/
k4+3FiDQ+NgeOry7NcDdXldTUfN9GqRk5bznVzavNugrrN0HmgiHhQYTjHEttlh6
JS6trZdINHTx4LpOlfMFhq+A1skK6JDDLcjS+YM1AXbBRGAoThd0VGb7hZhEn33U
aVXYFuD9ULxjDPzEVSqeTZrqy/6CaQkx8J7XSbpWh1u1MLBBvEABbqI5vN47/qHp
LfpBcNeExmbPbBMW267tcnlLvC3jeasCM7B8Ioq+hrnYqpJnW6lioFUjEhNShJzy
CiG19h8mkXNRAUdwnv63Bcnt9tsFL74SfHfJPkwW0OruGaJbB88A9yvotrRllCsn
xHnMxTB2Pf6qUF6gdPwkxfThil4FWKI6dgxIVLFamsuByrNt5CU3Ejdw2MKKeRRc
SPjftsy3yZPLD8XYKUCigDEzzXQU/5uNURJ7ZfLSjmBW0rqW63Wd3/kLDh/j8+BY
oDz4iyH1iWbPxpjqh63J0fhUYxgRRo7ORA5sLvEbr7sUbQyZFa1u5xlh8HlM8A9h
jOWpIaMD8aUJcm7VVhkYX4S7mZqHU2beEls5aSh3/EKk6lWn8XOL3dXDWuFJZWhv
o3wBsmPF/YAiRZtHuM5g/qhJHrXUEtR0WLrbxWvQk58l6kJ5r7o=
=9bMe
-----END PGP SIGNATURE-----
