fn main() {
    #[cfg(feature = "napi-bind")]
    napi_build::setup();
}
