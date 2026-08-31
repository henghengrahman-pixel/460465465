//go:build windows
package main

import (
  "bytes"
  "encoding/base64"
  "errors"
  "image"
  "image/jpeg"
  "syscall"
  "unsafe"
)

var (
  user32c=syscall.NewLazyDLL("user32.dll")
  gdi32c=syscall.NewLazyDLL("gdi32.dll")
  procGetDC=user32c.NewProc("GetDC")
  procReleaseDC=user32c.NewProc("ReleaseDC")
  procGetSystemMetrics=user32c.NewProc("GetSystemMetrics")
  procCreateCompatibleDC=gdi32c.NewProc("CreateCompatibleDC")
  procDeleteDC=gdi32c.NewProc("DeleteDC")
  procCreateCompatibleBitmap=gdi32c.NewProc("CreateCompatibleBitmap")
  procSelectObject=gdi32c.NewProc("SelectObject")
  procDeleteObject=gdi32c.NewProc("DeleteObject")
  procBitBlt=gdi32c.NewProc("BitBlt")
  procGetDIBits=gdi32c.NewProc("GetDIBits")
)

type bitmapInfoHeader struct { Size uint32; Width int32; Height int32; Planes uint16; BitCount uint16; Compression uint32; SizeImage uint32; XPelsPerMeter int32; YPelsPerMeter int32; ClrUsed uint32; ClrImportant uint32 }
type bitmapInfo struct { Header bitmapInfoHeader; Colors [1]uint32 }

func captureScreenJPEG()(string,int,int,error){
  w,_,_:=procGetSystemMetrics.Call(0); h,_,_:=procGetSystemMetrics.Call(1)
  if w==0||h==0{return "",0,0,errors.New("no active display")}
  hdc,_,_:=procGetDC.Call(0); if hdc==0{return "",0,0,errors.New("GetDC failed")}; defer procReleaseDC.Call(0,hdc)
  mem,_,_:=procCreateCompatibleDC.Call(hdc); if mem==0{return "",0,0,errors.New("CreateCompatibleDC failed")}; defer procDeleteDC.Call(mem)
  bmp,_,_:=procCreateCompatibleBitmap.Call(hdc,w,h); if bmp==0{return "",0,0,errors.New("CreateCompatibleBitmap failed")}; defer procDeleteObject.Call(bmp)
  old,_,_:=procSelectObject.Call(mem,bmp); defer procSelectObject.Call(mem,old)
  const SRCCOPY=0x00CC0020
  ok,_,_:=procBitBlt.Call(mem,0,0,w,h,hdc,0,0,SRCCOPY); if ok==0{return "",0,0,errors.New("BitBlt failed")}
  bi:=bitmapInfo{Header:bitmapInfoHeader{Size:uint32(unsafe.Sizeof(bitmapInfoHeader{})),Width:int32(w),Height:-int32(h),Planes:1,BitCount:32,Compression:0}}
  pixels:=make([]byte,int(w*h*4))
  got,_,_:=procGetDIBits.Call(mem,bmp,0,h,uintptr(unsafe.Pointer(&pixels[0])),uintptr(unsafe.Pointer(&bi)),0); if got==0{return "",0,0,errors.New("GetDIBits failed")}
  img:=image.NewRGBA(image.Rect(0,0,int(w),int(h)))
  for y:=0;y<int(h);y++{for x:=0;x<int(w);x++{i:=(y*int(w)+x)*4;o:=y*img.Stride+x*4;img.Pix[o]=pixels[i+2];img.Pix[o+1]=pixels[i+1];img.Pix[o+2]=pixels[i];img.Pix[o+3]=255}}
  var b bytes.Buffer; if err:=jpeg.Encode(&b,img,&jpeg.Options{Quality:45});err!=nil{return "",0,0,err}
  return base64.StdEncoding.EncodeToString(b.Bytes()),int(w),int(h),nil
}
