-----BEGIN PGP SIGNED MESSAGE-----
Hash: SHA512

Format: 3.0 (quilt)
Source: libqrtr-glib
Binary: libqrtr-glib0, libqrtr-glib-dev, libqrtr-glib-doc, gir1.2-qrtr-1.0
Architecture: linux-any all
Version: 1.4.0-1
Maintainer: DebianOnMobile Maintainers <debian-on-mobile-maintainers@alioth-lists.debian.net>
Uploaders: Arnaud Ferraris <aferraris@debian.org>, Guido Günther <agx@sigxcpu.org>, Henry-Nicolas Tourneur <debian@nilux.be>, Martin <debacle@debian.org>
Homepage: https://gitlab.freedesktop.org/mobile-broadband/libqrtr-glib/
Standards-Version: 4.7.2
Vcs-Browser: https://salsa.debian.org/DebianOnMobile-team/libqrtr-glib/
Vcs-Git: https://salsa.debian.org/DebianOnMobile-team/libqrtr-glib.git
Testsuite: autopkgtest
Testsuite-Triggers: build-essential, pkg-config
Build-Depends: debhelper-compat (= 13), dh-sequence-gir, gir1.2-gio-2.0-dev, gir1.2-gobject-2.0-dev, gobject-introspection (>= 1.80), libglib2.0-dev (>= 2.56), meson, pkgconf, python3:any
Build-Depends-Indep: gi-docgen <!nodoc>, libglib2.0-doc <!nodoc>
Package-List:
 gir1.2-qrtr-1.0 deb introspection optional arch=linux-any
 libqrtr-glib-dev deb libdevel optional arch=linux-any
 libqrtr-glib-doc deb doc optional arch=all profile=!nodoc profile:v1=!nodoc
 libqrtr-glib0 deb libs optional arch=linux-any
Checksums-Sha1:
 30d3e079f8970acc398fce731e4879746fd3ff6d 29521 libqrtr-glib_1.4.0.orig.tar.gz
 83cfd9c32795869503c9a640e77724e6e76f511a 5084 libqrtr-glib_1.4.0-1.debian.tar.xz
Checksums-Sha256:
 b57068934577b0070c2f180f3dfcd115ce19efec10aeaf877b8a99c9226aaa2c 29521 libqrtr-glib_1.4.0.orig.tar.gz
 3feec39c03c29824a6ce30b3beff6188501e771abca44eff64d9a267f0598241 5084 libqrtr-glib_1.4.0-1.debian.tar.xz
Files:
 08313a7983c619bdd8591d9efd32d415 29521 libqrtr-glib_1.4.0.orig.tar.gz
 e2750926376de90a0e6c9c55d276af1d 5084 libqrtr-glib_1.4.0-1.debian.tar.xz

-----BEGIN PGP SIGNATURE-----

iQIzBAEBCgAdFiEEY/bM35YinQkoayrDJb+GUkr8weMFAmlhBx8ACgkQJb+GUkr8
weMvjxAAnD5/YPOsbC+SQumamcV0ZV4DjHMH3vJoTU8JqTxvxd3FBsJwb2BoKOtK
NzjakK4yIgFi6WXmF7BdBVFkaYlV650FJFkoFmnJvXnVksw71g+RedhYVNSGEjMS
UZqMwZbQlf7sGDC2stIL4Jp5k/tAd3fs1G6cW6WPi+DeivDHlsxIN9XI5VEdR1js
FeFYVoI73dbQ/4Ms8teho6+3damnUtDy3JAHXb6DCY4vklI1kOlEWqVPp0FueEnq
WRqBBiEpV6u8PE3nK4zVCldKifJN1hJrujozkXUBGxB3N1Jj96jFI0mO+itg8Ar9
gAhTWRpdDulWTVGRRltg8FPt7nr8tbogDyX2y5Ogug64iEB+apdmy2Ia+Xox5W44
qp2K9cexKPdSn9ajbh2wpaqhqahXrHEgBh3JQ5NkB9qMqLZ/lJsVfFeo472PZFD4
2U0yCPUgPD4q9t3i03e0DDJ61gnjavIRJ0uI82idUD5w+NR0X0hDCaiIuj5RmRKB
x2V3i4hoFlLX+dfRUGLqyx8e2a1H4tVhd9SZbNugmIPuTXNMb2DiHjE5oSoaQx+/
ZaCh9UEqn6Dhlq6HO+ctnMK/+VlVKFcv3KguGEh0TBTDtVNmCizy7c54OlvB5wUD
tQZWGQHdB9kslTrh+17hF/yLG8I/hn2ZTCcppB/DDIbAZEER530=
=zmBE
-----END PGP SIGNATURE-----
