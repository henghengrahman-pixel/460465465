//go:build windows

package main

import (
	"bytes"
	"encoding/base64"
	"errors"
	"image"
	"image/jpeg"
	"math"
	"syscall"
	"unsafe"
)

var (
	user32c                    = syscall.NewLazyDLL("user32.dll")
	gdi32c                     = syscall.NewLazyDLL("gdi32.dll")
	procGetDC                  = user32c.NewProc("GetDC")
	procReleaseDC              = user32c.NewProc("ReleaseDC")
	procGetSystemMetrics       = user32c.NewProc("GetSystemMetrics")
	procCreateCompatibleDC     = gdi32c.NewProc("CreateCompatibleDC")
	procDeleteDC               = gdi32c.NewProc("DeleteDC")
	procCreateCompatibleBitmap = gdi32c.NewProc("CreateCompatibleBitmap")
	procSelectObject           = gdi32c.NewProc("SelectObject")
	procDeleteObject           = gdi32c.NewProc("DeleteObject")
	procBitBlt                 = gdi32c.NewProc("BitBlt")
	procGetDIBits              = gdi32c.NewProc("GetDIBits")
)

type bitmapInfoHeader struct {
	Size          uint32
	Width         int32
	Height        int32
	Planes        uint16
	BitCount      uint16
	Compression   uint32
	SizeImage     uint32
	XPelsPerMeter int32
	YPelsPerMeter int32
	ClrUsed       uint32
	ClrImportant  uint32
}
type bitmapInfo struct {
	Header bitmapInfoHeader
	Colors [1]uint32
}

const (
	smXVirtualScreen  = 76
	smYVirtualScreen  = 77
	smCXVirtualScreen = 78
	smCYVirtualScreen = 79
	srccopy           = 0x00CC0020
	captureblt        = 0x40000000
)

func metric(idx int) int {
	r, _, _ := procGetSystemMetrics.Call(uintptr(idx))
	return int(int32(r))
}

func resizeNearest(src *image.RGBA, maxW, maxH int) *image.RGBA {
	sw, sh := src.Bounds().Dx(), src.Bounds().Dy()
	if sw <= maxW && sh <= maxH {
		return src
	}
	scale := math.Min(float64(maxW)/float64(sw), float64(maxH)/float64(sh))
	dw := int(math.Max(1, math.Floor(float64(sw)*scale)))
	dh := int(math.Max(1, math.Floor(float64(sh)*scale)))
	dst := image.NewRGBA(image.Rect(0, 0, dw, dh))
	for y := 0; y < dh; y++ {
		sy := y * sh / dh
		for x := 0; x < dw; x++ {
			sx := x * sw / dw
			si := sy*src.Stride + sx*4
			di := y*dst.Stride + x*4
			copy(dst.Pix[di:di+4], src.Pix[si:si+4])
		}
	}
	return dst
}

func captureScreenJPEG() (string, int, int, error) {
	x := metric(smXVirtualScreen)
	y := metric(smYVirtualScreen)
	w := metric(smCXVirtualScreen)
	h := metric(smCYVirtualScreen)
	if w <= 0 || h <= 0 {
		w = metric(0)
		h = metric(1)
		x = 0
		y = 0
	}
	if w <= 0 || h <= 0 {
		return "", 0, 0, errors.New("no active display")
	}
	hdc, _, _ := procGetDC.Call(0)
	if hdc == 0 {
		return "", 0, 0, errors.New("GetDC failed")
	}
	defer procReleaseDC.Call(0, hdc)
	mem, _, _ := procCreateCompatibleDC.Call(hdc)
	if mem == 0 {
		return "", 0, 0, errors.New("CreateCompatibleDC failed")
	}
	defer procDeleteDC.Call(mem)
	bmp, _, _ := procCreateCompatibleBitmap.Call(hdc, uintptr(w), uintptr(h))
	if bmp == 0 {
		return "", 0, 0, errors.New("CreateCompatibleBitmap failed")
	}
	defer procDeleteObject.Call(bmp)
	old, _, _ := procSelectObject.Call(mem, bmp)
	defer procSelectObject.Call(mem, old)
	ok, _, _ := procBitBlt.Call(mem, 0, 0, uintptr(w), uintptr(h), hdc, uintptr(x), uintptr(y), uintptr(srccopy|captureblt))
	if ok == 0 {
		return "", 0, 0, errors.New("BitBlt failed")
	}
	bi := bitmapInfo{Header: bitmapInfoHeader{Size: uint32(unsafe.Sizeof(bitmapInfoHeader{})), Width: int32(w), Height: -int32(h), Planes: 1, BitCount: 32, Compression: 0}}
	pixels := make([]byte, w*h*4)
	got, _, _ := procGetDIBits.Call(mem, bmp, 0, uintptr(h), uintptr(unsafe.Pointer(&pixels[0])), uintptr(unsafe.Pointer(&bi)), 0)
	if got == 0 {
		return "", 0, 0, errors.New("GetDIBits failed")
	}
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for py := 0; py < h; py++ {
		for px := 0; px < w; px++ {
			i := (py*w + px) * 4
			o := py*img.Stride + px*4
			img.Pix[o] = pixels[i+2]
			img.Pix[o+1] = pixels[i+1]
			img.Pix[o+2] = pixels[i]
			img.Pix[o+3] = 255
		}
	}
	out := resizeNearest(img, 1920, 1080)
	var b bytes.Buffer
	if err := jpeg.Encode(&b, out, &jpeg.Options{Quality: 50}); err != nil {
		return "", 0, 0, err
	}
	return base64.StdEncoding.EncodeToString(b.Bytes()), out.Bounds().Dx(), out.Bounds().Dy(), nil
}
