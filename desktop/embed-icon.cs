using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;

public static class XiaojingWindowsResources
{
    private static readonly IntPtr IconType = new IntPtr(3);
    private static readonly IntPtr GroupType = new IntPtr(14);
    private static readonly IntPtr VersionType = new IntPtr(16);
    // The pinned Electron runtime uses resource 1 (en-US) for icon group and version.
    private static readonly IntPtr MainId = new IntPtr(1);
    private const ushort Language = 1033;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr BeginUpdateResource(string file, bool deleteExisting);
    [DllImport("kernel32.dll", EntryPoint = "UpdateResourceW", SetLastError = true)]
    private static extern bool UpdateResource(IntPtr handle, IntPtr type, IntPtr id, ushort language, byte[] bytes, int size);
    [DllImport("kernel32.dll", EntryPoint = "EndUpdateResourceW", SetLastError = true)]
    private static extern bool EndUpdateResource(IntPtr handle, bool discard);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr LoadLibraryEx(string file, IntPtr reserved, uint flags);
    [DllImport("kernel32.dll", EntryPoint = "FindResourceExW", SetLastError = true)]
    private static extern IntPtr FindResourceEx(IntPtr module, IntPtr type, IntPtr id, ushort language);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr LoadResource(IntPtr module, IntPtr resource);
    [DllImport("kernel32.dll")]
    private static extern IntPtr LockResource(IntPtr resource);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern int SizeofResource(IntPtr module, IntPtr resource);
    [DllImport("kernel32.dll")]
    private static extern bool FreeLibrary(IntPtr module);

    private static void Require(bool success)
    {
        if (!success) throw new Win32Exception(Marshal.GetLastWin32Error());
    }

    public static int Main(string[] args)
    {
        if (args.Length != 3)
        {
            Console.Error.WriteLine("Usage: embed-icon.exe <executable> <icon> <version>");
            return 2;
        }
        try
        {
            Embed(args[0], args[1], args[2]);
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.Message);
            return 1;
        }
    }

    private static void Embed(string executable, string icon, string version)
    {
        byte[] ico = File.ReadAllBytes(icon);
        if (ico.Length < 6 || BitConverter.ToUInt16(ico, 0) != 0 || BitConverter.ToUInt16(ico, 2) != 1)
            throw new InvalidDataException("Expected a Windows ICO file.");
        int count = BitConverter.ToUInt16(ico, 4);
        int directoryEnd = 6 + count * 16;
        if (count == 0 || directoryEnd > ico.Length) throw new InvalidDataException("Invalid ICO directory.");

        byte[] group = new byte[6 + count * 14];
        var frames = new byte[count][];
        Array.Copy(ico, group, 6);
        for (int i = 0; i < count; i++)
        {
            int entry = 6 + i * 16;
            int size = BitConverter.ToInt32(ico, entry + 8);
            int offset = BitConverter.ToInt32(ico, entry + 12);
            if (size <= 0 || offset < directoryEnd || (long)offset + size > ico.Length)
                throw new InvalidDataException("ICO frame extends outside the file.");
            frames[i] = new byte[size];
            Array.Copy(ico, offset, frames[i], 0, size);
            // A resource entry replaces the ICO's image offset with a WORD resource ID.
            Array.Copy(ico, entry, group, 6 + i * 14, 12);
            Array.Copy(BitConverter.GetBytes((ushort)(i + 1)), 0, group, 18 + i * 14, 2);
        }

        byte[] versionResource = BuildVersionResource(executable, version);
        IntPtr update = BeginUpdateResource(executable, false);
        Require(update != IntPtr.Zero);
        try
        {
            for (int i = 0; i < count; i++)
                Require(UpdateResource(update, IconType, new IntPtr(i + 1), Language, frames[i], frames[i].Length));
            Require(UpdateResource(update, GroupType, MainId, Language, group, group.Length));
            Require(UpdateResource(update, VersionType, MainId, Language, versionResource, versionResource.Length));
        }
        catch
        {
            EndUpdateResource(update, true);
            throw;
        }
        Require(EndUpdateResource(update, false));

        // Read the finished executable as resources only, without running its code.
        IntPtr module = LoadLibraryEx(executable, IntPtr.Zero, 0x22);
        Require(module != IntPtr.Zero);
        try
        {
            Verify(module, GroupType, MainId, group);
            Verify(module, VersionType, MainId, versionResource);
            for (int i = 0; i < count; i++) Verify(module, IconType, new IntPtr(i + 1), frames[i]);
        }
        finally { FreeLibrary(module); }
    }

    private static byte[] BuildVersionResource(string executable, string version)
    {
        Version numeric;
        if (!Version.TryParse(version.Split('-', '+')[0], out numeric) || numeric.Build < 0 || numeric.Revision >= 0 ||
            numeric.Major > ushort.MaxValue || numeric.Minor > ushort.MaxValue || numeric.Build > ushort.MaxValue)
            throw new InvalidDataException("Expected a package version with three 16-bit numeric parts.");

        IntPtr module = LoadLibraryEx(executable, IntPtr.Zero, 0x22);
        Require(module != IntPtr.Zero);
        byte[] original;
        try { original = ReadResource(module, VersionType, MainId); }
        finally { FreeLibrary(module); }

        var strings = new Dictionary<string, string> {
            { "FileDescription", "Xiaojing Job Search Assistant" },
            { "FileVersion", version },
            { "InternalName", "Xiaojing.exe" },
            { "OriginalFilename", "Xiaojing.exe" },
            { "ProductName", "Xiaojing Desktop" },
            { "ProductVersion", version }
        };
        return RewriteVersionBlock(original, 0, original.Length, numeric, strings);
    }

    private static int AlignDword(int value) { return (value + 3) & ~3; }

    private static byte[] RewriteVersionBlock(byte[] data, int start, int limit, Version version,
        Dictionary<string, string> strings)
    {
        if (start + 6 > limit) throw new InvalidDataException("Truncated Windows version block.");
        int end = start + BitConverter.ToUInt16(data, start);
        int length = BitConverter.ToUInt16(data, start + 2);
        int type = BitConverter.ToUInt16(data, start + 4);
        int keyStart = start + 6, keyEnd = keyStart;
        if (end > limit || end < keyStart || type > 1) throw new InvalidDataException("Invalid Windows version block.");
        while (keyEnd + 2 <= end && BitConverter.ToUInt16(data, keyEnd) != 0) keyEnd += 2;
        if (keyEnd + 2 > end) throw new InvalidDataException("Invalid Windows version key.");
        string key = Encoding.Unicode.GetString(data, keyStart, keyEnd - keyStart);
        int valueStart = AlignDword(keyEnd + 2), valueBytes = length * (type == 1 ? 2 : 1);
        if (valueStart + valueBytes > end) throw new InvalidDataException("Invalid Windows version value.");
        var value = new byte[valueBytes];
        Array.Copy(data, valueStart, value, 0, valueBytes);
        if (start == 0)
        {
            if (key != "VS_VERSION_INFO" || type != 0 || valueBytes != 52 || BitConverter.ToUInt32(value, 0) != 0xfeef04bd)
                throw new InvalidDataException("Invalid Windows fixed version information.");
            byte[] majorMinor = BitConverter.GetBytes(((uint)version.Major << 16) | (uint)version.Minor);
            byte[] buildRevision = BitConverter.GetBytes((uint)version.Build << 16);
            Array.Copy(majorMinor, 0, value, 8, 4);
            Array.Copy(buildRevision, 0, value, 12, 4);
            Array.Copy(majorMinor, 0, value, 16, 4);
            Array.Copy(buildRevision, 0, value, 20, 4);
        }
        else
        {
            string replacement;
            if (type == 1 && strings.TryGetValue(key, out replacement)) value = Encoding.Unicode.GetBytes(replacement + "\0");
        }

        using (var output = new MemoryStream())
        using (var writer = new BinaryWriter(output))
        {
            // Preserve the original key, language tables, and vendor metadata.
            writer.Write(data, start, valueStart - start);
            writer.Write(value);
            for (int child = AlignDword(valueStart + valueBytes); child < end;)
            {
                while (output.Position % 4 != 0) writer.Write((byte)0);
                writer.Write(RewriteVersionBlock(data, child, end, version, strings));
                child = AlignDword(child + BitConverter.ToUInt16(data, child));
            }
            ushort outputLength = checked((ushort)output.Length);
            output.Position = 0;
            writer.Write(outputLength);
            writer.Write(checked((ushort)(value.Length / (type == 1 ? 2 : 1))));
            return output.ToArray();
        }
    }

    private static byte[] ReadResource(IntPtr module, IntPtr type, IntPtr id)
    {
        IntPtr resource = FindResourceEx(module, type, id, Language);
        Require(resource != IntPtr.Zero);
        IntPtr data = LoadResource(module, resource);
        Require(data != IntPtr.Zero);
        IntPtr bytes = LockResource(data);
        int length = SizeofResource(module, resource);
        if (bytes == IntPtr.Zero || length <= 0) throw new InvalidDataException("Windows resource could not be read.");
        var actual = new byte[length];
        Marshal.Copy(bytes, actual, 0, actual.Length);
        return actual;
    }

    private static void Verify(IntPtr module, IntPtr type, IntPtr id, byte[] expected)
    {
        if (!ReadResource(module, type, id).SequenceEqual(expected))
            throw new InvalidDataException("Embedded Windows resource differs from the expected data.");
    }
}
