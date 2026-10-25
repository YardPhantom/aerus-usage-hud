using System.Diagnostics;
using System.Net;
using System.Net.Sockets;

namespace Aerus.UsageHud.Desktop;

// Manages the bundled local Node.js server process bound strictly to 127.0.0.1.
internal sealed class LocalServerHost : IDisposable
{
    private const int FirstPort = 8790;
    private const int PortAttempts = 10;

    private readonly string _appRoot;
    private readonly string _dataRoot;
    private Process? _server;
    private ChildJob? _job;

    public LocalServerHost(string appRoot, string dataRoot)
    {
        _appRoot = appRoot;
        _dataRoot = dataRoot;
    }

    public async Task<string?> StartAndWaitAsync(TimeSpan timeout)
    {
        var port = FindFreePort();
        var url = $"http://127.0.0.1:{port}/";
        StartProcess(port);
        var ready = await WaitForServerAsync(url, timeout);
        return ready ? url : null;
    }

    private void StartProcess(int port)
    {
        var node = Path.Combine(_appRoot, "runtime", "node.exe");
        var script = Path.Combine(_appRoot, "server.js");
        if (!File.Exists(node) || !File.Exists(script))
        {
            throw new FileNotFoundException("The HUD program files are incomplete.", File.Exists(node) ? script : node);
        }

        var startInfo = new ProcessStartInfo(node)
        {
            WorkingDirectory = _appRoot,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        startInfo.ArgumentList.Add(script);
        startInfo.ArgumentList.Add("--no-open");
        startInfo.Environment["PORT"] = port.ToString();
        startInfo.Environment["AERUS_DATA_DIR"] = Path.Combine(_dataRoot, "data");
        _job ??= new ChildJob();
        _server = Process.Start(startInfo);
        if (_server is not null) _job.Add(_server);
    }

    private async Task<bool> WaitForServerAsync(string url, TimeSpan timeout)
    {
        using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
        var stopwatch = Stopwatch.StartNew();
        while (stopwatch.Elapsed < timeout)
        {
            if (_server is null || _server.HasExited) return false;
            try
            {
                using var response = await client.GetAsync(url);
                if (response.IsSuccessStatusCode) return true;
            }
            catch (HttpRequestException)
            {
                // Not listening yet.
            }
            await Task.Delay(250);
        }
        return false;
    }

    private static int FindFreePort()
    {
        for (var port = FirstPort; port < FirstPort + PortAttempts; port++)
        {
            var listener = new TcpListener(IPAddress.Loopback, port);
            try
            {
                listener.Start();
                return port;
            }
            catch (SocketException)
            {
                // Taken. Try the next one.
            }
            finally
            {
                listener.Stop();
            }
        }
        throw new InvalidOperationException($"Ports {FirstPort}–{FirstPort + PortAttempts - 1} are all in use.");
    }

    public void Dispose()
    {
        try
        {
            if (_server is not null && !_server.HasExited) _server.Kill(entireProcessTree: true);
        }
        catch (InvalidOperationException)
        {
            // Already exited.
        }
        _job?.Dispose();
        _job = null;
    }
}
