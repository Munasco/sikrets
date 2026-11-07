# Template for Formula/sikrets.rb in the Homebrew tap (Munasco/homebrew-tap).
# The release workflow fills in __VERSION__, __REPO__ and the __SHA256_*__ values from SHA256SUMS
# and pushes the result to the tap. Don't edit the tap's copy by hand.
class Sikrets < Formula
  desc "Connect providers, provision and rotate credentials"
  homepage "https://sikrets.usetennant.com"
  version "__VERSION__"

  on_macos do
    on_arm do
      url "https://github.com/__REPO__/releases/download/v#{version}/sikrets-darwin-arm64"
      sha256 "__SHA256_DARWIN_ARM64__"
    end
    on_intel do
      url "https://github.com/__REPO__/releases/download/v#{version}/sikrets-darwin-x64"
      sha256 "__SHA256_DARWIN_X64__"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/__REPO__/releases/download/v#{version}/sikrets-linux-arm64"
      sha256 "__SHA256_LINUX_ARM64__"
    end
    on_intel do
      url "https://github.com/__REPO__/releases/download/v#{version}/sikrets-linux-x64"
      sha256 "__SHA256_LINUX_X64__"
    end
  end

  def install
    bin.install Dir["sikrets-*"].first => "sikrets"
  end

  test do
    assert_equal version.to_s, shell_output("#{bin}/sikrets --version").strip
  end
end
