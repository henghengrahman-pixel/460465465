//go:build !windows
package main
import "errors"
func captureScreenJPEG()(string,int,int,error){return "",0,0,errors.New("screen capture only supported on Windows")}
